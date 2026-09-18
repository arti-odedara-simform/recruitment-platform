-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('INTERVIEWER', 'RECRUITER', 'HIRING_MANAGER');

-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('APPLIED', 'SCREEN', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TransitionKind" AS ENUM ('NORMAL', 'OVERRIDE');

-- CreateEnum
CREATE TYPE "RoleStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "hiringManagerId" TEXT NOT NULL,
    "status" "RoleStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "currentStage" "Stage" NOT NULL DEFAULT 'APPLIED',
    "currentStageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewRound" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "stage" "Stage" NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterviewRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundAssignment" (
    "roundId" TEXT NOT NULL,
    "interviewerId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoundAssignment_pkey" PRIMARY KEY ("roundId","interviewerId")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "interviewerId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "notes" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageTransition" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "fromStage" "Stage" NOT NULL,
    "toStage" "Stage" NOT NULL,
    "kind" "TransitionKind" NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StageTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "Role_status_idx" ON "Role"("status");

-- CreateIndex
CREATE INDEX "Role_hiringManagerId_idx" ON "Role"("hiringManagerId");

-- CreateIndex
CREATE INDEX "Application_roleId_currentStage_currentStageEnteredAt_idx" ON "Application"("roleId", "currentStage", "currentStageEnteredAt");

-- CreateIndex
CREATE INDEX "Application_currentStage_currentStageEnteredAt_idx" ON "Application"("currentStage", "currentStageEnteredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Application_candidateId_roleId_key" ON "Application"("candidateId", "roleId");

-- CreateIndex
CREATE INDEX "InterviewRound_applicationId_idx" ON "InterviewRound"("applicationId");

-- CreateIndex
CREATE INDEX "InterviewRound_scheduledAt_idx" ON "InterviewRound"("scheduledAt");

-- CreateIndex
CREATE INDEX "RoundAssignment_interviewerId_idx" ON "RoundAssignment"("interviewerId");

-- CreateIndex
CREATE INDEX "Feedback_roundId_idx" ON "Feedback"("roundId");

-- CreateIndex
CREATE UNIQUE INDEX "Feedback_roundId_interviewerId_key" ON "Feedback"("roundId", "interviewerId");

-- CreateIndex
CREATE INDEX "StageTransition_candidateId_roleId_occurredAt_idx" ON "StageTransition"("candidateId", "roleId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_entity_entityId_occurredAt_idx" ON "AuditEvent"("entity", "entityId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_occurredAt_idx" ON "AuditEvent"("actorId", "occurredAt");

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_hiringManagerId_fkey" FOREIGN KEY ("hiringManagerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewRound" ADD CONSTRAINT "InterviewRound_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundAssignment" ADD CONSTRAINT "RoundAssignment_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InterviewRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundAssignment" ADD CONSTRAINT "RoundAssignment_interviewerId_fkey" FOREIGN KEY ("interviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundAssignment" ADD CONSTRAINT "RoundAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InterviewRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_interviewerId_fkey" FOREIGN KEY ("interviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageTransition" ADD CONSTRAINT "StageTransition_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageTransition" ADD CONSTRAINT "StageTransition_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageTransition" ADD CONSTRAINT "StageTransition_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Constraints Prisma's schema language cannot express (PLAN.md §2).
--
-- These are the point of the design: an override with no reason is rejected by the
-- database, so "recorded, not inferred" stays true even when the service layer is
-- bypassed -- including from a psql prompt at the walkthrough.
-- ---------------------------------------------------------------------------

ALTER TABLE "StageTransition" ADD CONSTRAINT override_requires_reason
  CHECK (kind <> 'OVERRIDE' OR (reason IS NOT NULL AND length(btrim(reason)) >= 10));

ALTER TABLE "Feedback" ADD CONSTRAINT rating_range
  CHECK (rating BETWEEN 1 AND 4);
