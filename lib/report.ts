import { generateText } from "./gemini";
import prisma from "./prisma";
import type { QuestionAsked } from "./generated/prisma";
import type { MonthlyReport } from "./report-types";

// Fetch every question asked in the past month from the database
async function getMonthlyQuestions(): Promise<QuestionAsked[]> {
  const since = new Date();
  since.setDate(since.getDate() - 30);

  return prisma.questionAsked.findMany({
    where: {
      timestamp: { gte: since },
    },
    orderBy: { timestamp: "desc" },
  });
}