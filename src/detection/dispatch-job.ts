/**
 * Dispatch Job
 *
 * Output of dispatch planner after determining which accounts
 * must receive a job for a matched ChannelPostReceived.
 *
 * ONE DispatchJob per (accountId, sourceMessageId) combination.
 * Multiple accounts → Multiple jobs.
 * Multiple triggers → Still one job per account (triggers preserved in array).
 *
 * This phase does NOT execute the job:
 * - No reply yet
 * - No delay yet
 * - No reaction yet
 * - No reporting yet
 *
 * Future phases consume these jobs.
 */

export interface DispatchJob {
  readonly accountId: number;
  readonly channelId: number;
  readonly sourceMessageId: number;
  readonly matchedTriggers: readonly string[];
  readonly sourceText: string;
  readonly senderDisplayName: string;
  readonly timestamp: Date;
}
