// Repository for managing questions asked by Slack users.
// Uses Prisma Client for all database operations instead of raw SQL.
import prisma from "../prisma";
import type { QuestionAsked } from "../generated/prisma";
import type { CreateQuestionAsked } from "../db-types";

// Insert a new question record
export async function insertQuestion(
  data: CreateQuestionAsked,
): Promise<QuestionAsked> {
  return prisma.questionAsked.create({
    data: {
      user_id: data.user_id,
      question_text: data.question_text,
    },
  });
}

// Find a question by ID
export async function findQuestionById(
  id: number,
): Promise<QuestionAsked | null> {
  return prisma.questionAsked.findUnique({
    where: { id },
  });
}

// Get questions by user ID with pagination
export async function getQuestionsByUserId(
  userId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<QuestionAsked[]> {
  return prisma.questionAsked.findMany({
    where: { user_id: userId },
    orderBy: { timestamp: "desc" },
    take: limit,
    skip: offset,
  });
}

// Get recent questions across all users with pagination
export async function getRecentQuestions(
  limit: number = 50,
  offset: number = 0,
): Promise<QuestionAsked[]> {
  return prisma.questionAsked.findMany({
    orderBy: { timestamp: "desc" },
    take: limit,
    skip: offset,
  });
}

// Count total questions asked by a specific user
export async function countQuestionsByUser(userId: string): Promise<number> {
  return prisma.questionAsked.count({
    where: { user_id: userId },
  });
}

// Delete a question by ID — useful for user offboarding or data cleanup
export async function deleteQuestion(id: number): Promise<boolean> {
  const result = await prisma.questionAsked.deleteMany({
    where: { id },
  });
  return result.count > 0;
}

// Get questions from the last N days — used for monthly report generation
export async function getQuestionsFromLastDays(
  days: number,
): Promise<QuestionAsked[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  return prisma.questionAsked.findMany({
    where: {
      timestamp: { gte: since },
    },
    orderBy: { timestamp: "desc" },
  });
}
