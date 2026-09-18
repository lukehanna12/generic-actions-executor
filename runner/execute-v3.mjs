import fs from "node:fs/promises";
import path from "node:path";
import { parseTriggerRequest } from "./trigger-request.mjs";
import { fetchRequestRecord } from "./job-source.mjs";
import { parseOuterRequest, unwrapAesKey } from "./request.mjs";
import { openInput } from "./crypto.mjs";
import { normalizePrivateInput } from "./private-input.mjs";
import { exactSourceArchive } from "./source-access.mjs";
import { GitHubArchiveMaterializer } from "./source-materializer.mjs";
import { CandidateSupervisorFactory } from "./supervisor-factory.mjs";
import { CandidateEnvironmentEngine } from "./environment-engine.mjs";

export const EXECUTOR_V3_READY = true;
