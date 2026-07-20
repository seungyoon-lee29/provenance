import { PersonalCacheStore } from "../../src/modules/financial-information/data/personal-cache";
import { personalCacheContract } from "./personal-cache-contract";

// The in-memory impl is the behavioral oracle; the pg impl (ticket 23 later slice)
// runs this same contract.
personalCacheContract("in-memory", () => new PersonalCacheStore<string>());
