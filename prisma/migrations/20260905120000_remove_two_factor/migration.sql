-- The twoFactorEnabled flag was stored but never read or enforced anywhere
-- (login is Google-only; no TOTP exists). Removing the dead column.
ALTER TABLE "User" DROP COLUMN "twoFactorEnabled";
