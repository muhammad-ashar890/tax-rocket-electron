-- Persist the furthest currently-valid wizard completion boundary separately
-- from the screen the user is viewing. Upstream edits can now shrink this
-- value without losing normal back-navigation state.
ALTER TABLE "FilingDraft"
ADD COLUMN "wizardCompletionStep" INTEGER NOT NULL DEFAULT 0;

-- Preserve existing navigation history at deployment. The first subsequent
-- upstream source/category edit resets this boundary authoritatively.
UPDATE "FilingDraft"
SET "wizardCompletionStep" = "currentStep";
