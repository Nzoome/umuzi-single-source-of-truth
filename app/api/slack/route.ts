import { NextRequest, NextResponse } from "next/server";
import { askQuestion } from "../../../lib/rag";
import type { ConversationMessage } from "../../../lib/rag";
import { insertQuestion } from "../../../lib/repositories/questions-asked";
import { mdToSlack, formatSources } from "../../../lib/slack-format";

/** Strip the `<@BOTID>` mention prefix so we get a clean question. */
function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

// Post a Slack message via chat.postMessage. Replies in a thread when thread_ts is provided.
async function postSlackMessage(
  channel: string,
  text: string,
  threadTs?: string,
) {
  const payload: Record<string, string> = { channel, text };
  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error("chat.postMessage HTTP error:", res.status, await res.text());
  }
}

/**
 * Fetch the conversation history from a Slack thread.
 * Returns the previous messages as ConversationMessage objects.
 * Excludes the latest message since that's the current question.
 */
async function fetchThreadHistory(
  channel: string,
  threadTs: string,
  botUserId: string,
): Promise<ConversationMessage[]> {
  const res = await fetch(
    `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
    },
  );

  if (!res.ok) {
    console.error("conversations.replies HTTP error:", res.status);
    return [];
  }

  const data = await res.json();

  if (!data.ok || !Array.isArray(data.messages)) {
    console.error("conversations.replies error:", data.error);
    return [];
  }

  // Exclude the last message (that's the current question being processed)
  const previousMessages = data.messages.slice(0, -1);

  return previousMessages
    .filter((m: { text?: string }) => m.text?.trim())
    .map((m: { user?: string; bot_id?: string; text: string }) => ({
      role: m.bot_id || m.user === botUserId ? "assistant" : "user",
      // Strip bot mentions from user messages
      text: stripMention(m.text).trim(),
    })) as ConversationMessage[];
}

/**
 * Get the bot's own user ID from the Slack API.
 * Used to identify which messages in a thread are from the bot.
 */
async function getBotUserId(): Promise<string> {
  const res = await fetch("https://slack.com/api/auth.test", {
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
  });

  const data = await res.json();
  return data.user_id ?? "";
}

// Background processor (fire-and-forget)

/**
 * Runs the full RAG pipeline and posts the answer back into the
 * Slack channel / DM where the question originated.
 * Fetches thread history for multi-turn conversations when threadTs is provided.
 */
async function processAndReply(
  question: string,
  userId: string,
  channel: string,
  threadTs?: string,
) {
  try {
    // 1. Log the question
    await insertQuestion({ user_id: userId, question_text: question });

    // 2. Fetch thread history for conversational context
    let history: ConversationMessage[] = [];
    if (threadTs) {
      const botUserId = await getBotUserId();
      history = await fetchThreadHistory(channel, threadTs, botUserId);
    }

    // 3. Run RAG with conversation history
    const { answer, sources } = await askQuestion(question, 10, history);

    // 4. Format response with sources
    const sourceList = formatSources(sources);

    const slackAnswer = mdToSlack(answer);
    const text = sourceList
      ? `${slackAnswer}\n\n*Sources:*\n${sourceList}`
      : slackAnswer;

    // 5. Send to Slack (threaded when threadTs is available)
    await postSlackMessage(channel, text, threadTs);
  } catch (error) {
    console.error("Error processing Slack event:", error);
    await postSlackMessage(
      channel,
      "Sorry, something went wrong while processing your question. Please try again.",
      threadTs,
    );
  }
}

// Route handler

/**
 * POST /api/slack
 *
 * Receives Slack Events API payloads:
 *   • url_verification  — one-time challenge handshake
 *   • event_callback     — real-time events
 *       ◦ app_mention   — someone @-mentioned the bot in a channel
 *       ◦ message (DM)  — someone sent a direct message to the bot
 *
 * We ACK immediately (200) and process in the background so Slack
 * doesn't retry due to a 3-second timeout.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();

  // 1. URL verification (Slack setup handshake)
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // 2. Event callbacks
  if (body.type === "event_callback") {
    const event = body.event;
    if (!event) {
      return NextResponse.json({ ok: true });
    }

    // Ignore messages from bots (avoid infinite loops)
    if (event.bot_id || event.subtype === "bot_message") {
      return NextResponse.json({ ok: true });
    }

    const userId: string = event.user ?? "anonymous";
    const channel: string = event.channel;

    // 2a. @mention in a channel — reply in a thread under the original message
    if (event.type === "app_mention") {
      const question = stripMention(event.text ?? "");
      const threadTs: string = event.thread_ts ?? event.ts;

      if (!question) {
        await postSlackMessage(
          channel,
          "👋 Hey! Ask me a question after the mention, e.g. `@Zazu How do I apply for leave?`",
          threadTs,
        );
        return NextResponse.json({ ok: true });
      }

      // ACK immediately, process in background
      processAndReply(question, userId, channel, threadTs);
      return NextResponse.json({ ok: true });
    }

    // 2b. Direct message to the bot
    if (event.type === "message" && event.channel_type === "im") {
      const question = (event.text ?? "").trim();

      if (!question) {
        await postSlackMessage(
          channel,
          "👋 Hi there! Go ahead and ask me anything.",
        );
        return NextResponse.json({ ok: true });
      }

      // ACK immediately, process in background — no threadTs for DMs
      processAndReply(question, userId, channel);
      return NextResponse.json({ ok: true });
    }
  }

  // Fallback
  return NextResponse.json({ ok: true });
}