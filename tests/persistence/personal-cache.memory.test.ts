import { PersonalCacheStore } from "../../src/modules/financial-information/data/personal-cache";
import { personalCacheContract } from "./personal-cache-contract";

// The in-memory impl is the behavioral oracle; the pg impl (personal-cache.pg.test.ts)
// runs this same contract.
personalCacheContract("in-memory", () => Promise.resolve(new PersonalCacheStore<string>()));
