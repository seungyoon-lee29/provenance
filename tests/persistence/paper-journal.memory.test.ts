import { MemoryPaperJournalStore } from "../../src/modules/paper-trading/internal/journal";
import { paperJournalContract } from "./paper-journal-contract";

// The in-memory impl is the behavioral oracle; the pg impl (paper-journal.pg.test.ts)
// runs this same contract.
paperJournalContract("in-memory", () => Promise.resolve(new MemoryPaperJournalStore()));
