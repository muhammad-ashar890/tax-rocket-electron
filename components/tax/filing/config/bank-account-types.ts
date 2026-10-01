export type DraftBankAccount = {
  id?: string;
  clientId: string;
  bankName: string;
  accountLabel: string;
  /**
   * Read from the bank statement (required there). Carried here only so a
   * re-save of the account list keeps it; it is not asked for in this step.
   */
  iban: string;
};

/** One rule for "this account card is filled in", shared by every gate. */
export function isBankAccountComplete(account: DraftBankAccount): boolean {
  return (
    account.bankName.trim().length > 0 && account.accountLabel.trim().length > 0
  );
}
