import { IdentitySessionStore } from "../../src/modules/identity/session-store";
import { identityStoreContract } from "./identity-store-contract";

// The in-memory impl is the oracle side of the contract; the pg impl (slice 3b-iii) runs the SAME
// suite against real postgres so the two cannot silently diverge.
identityStoreContract("in-memory", (clock, entropy) => Promise.resolve(new IdentitySessionStore(clock, entropy)));
