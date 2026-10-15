import { describe, expect, it } from "vitest";
import { FAST_REPLAY_MS, isSafeRunId, replaySchedule } from "../replay";
import { maskHandle, maskMentions } from "../maskText";
import * as runs from "../runs";
import * as mask from "../../components/mask";

describe("browser-safe shared helpers", () => {
  it("keeps the original exports and timing contract", () => {
    expect(runs.replaySchedule).toBe(replaySchedule);
    expect(runs.isSafeRunId).toBe(isSafeRunId);
    expect(runs.FAST_REPLAY_MS).toBe(FAST_REPLAY_MS);
    expect(isSafeRunId("../run")).toBe(false);
    expect(replaySchedule([{ t: 36000, event: { type: "fetched", total: 1 } }], "fast")[0].at).toBe(18000);
  });
  it("keeps masking available to React and plain TypeScript callers", () => {
    expect(mask.maskHandle).toBe(maskHandle);
    expect(mask.maskMentions).toBe(maskMentions);
    expect(maskHandle("@jasmine42")).toBe("@ja***42");
    expect(maskMentions("hi ＠jasmine42")).toBe("hi @ja***42");
  });
});
