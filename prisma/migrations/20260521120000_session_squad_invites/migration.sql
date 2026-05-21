-- CreateTable
CREATE TABLE "session_squad_invites" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "invitee_id" TEXT NOT NULL,
    "status" "SquadFillInviteStatus" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_squad_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_squad_invites_invitee_id_status_idx" ON "session_squad_invites"("invitee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "session_squad_invites_session_id_invitee_id_key" ON "session_squad_invites"("session_id", "invitee_id");

-- AddForeignKey
ALTER TABLE "session_squad_invites" ADD CONSTRAINT "session_squad_invites_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_squad_invites" ADD CONSTRAINT "session_squad_invites_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_squad_invites" ADD CONSTRAINT "session_squad_invites_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
