import { describe, expect, test } from "bun:test";
import { JudgeReply, RUBRIC, scorePlay } from "../bench/rubric";

const reply = (scores: Partial<Record<keyof typeof RUBRIC, number>> = {}, mistakes: unknown[] = [], extra: object = {}) => ({
  mistakes,
  audit: {},
  scores: Object.fromEntries(Object.keys(RUBRIC).map((key) => [key, { score: scores[key as keyof typeof RUBRIC] ?? 7, reason: "r" }])),
  happened: { npcDied: false, pcInMortalDanger: false },
  ...extra,
});
const mistake = (kind: string, weight: "major" | "minor", feature?: string) => ({ kind, weight, where: "M2", note: "n", ...(feature && { feature }) });
const scored = (value: object, turns = 50) => scorePlay(JudgeReply.parse(value), turns);

describe("scorePlay", () => {
  test("a clean play keeps its scores, and the overall is their mean", () => {
    const flat = scored(reply());
    expect(flat["judge.secrets"]).toBe(7);
    expect(flat["judge.overall"]).toBe(7);
    expect(flat["judge.craft"]).toBe(7);
    expect(flat["mistakes.major"]).toBe(0);
  });

  test("one major leak caps secrets, surprise and a mystery score at 4, keeping the judge's own", () => {
    const flat = scored(reply({ secrets: 6, surprise: 8 }, [mistake("secret", "major")], { mystery: { score: 7, reason: "r" } }));
    expect(flat["judge.secrets"]).toBe(4);
    expect(flat["judge.surprise"]).toBe(4);
    expect(flat["judge.mystery"]).toBe(4);
    expect(flat["judge.raw.surprise"]).toBe(8);
    expect(flat["judge.craft"]).toBeGreaterThan(flat["judge.overall"]!);
  });

  test("minors cap only at a rate of one per 10 Turns", () => {
    const twoIn50 = scored(reply({}, [mistake("contradiction", "minor"), mistake("contradiction", "minor")]));
    expect(twoIn50["judge.continuity"]).toBe(7);
    const fiveIn50 = scored(
      reply(
        {},
        Array.from({ length: 5 }, () => mistake("contradiction", "minor")),
      ),
    );
    expect(fiveIn50["judge.continuity"]).toBe(4);
  });

  test("a restart caps continuity and pacing at 3", () => {
    const flat = scored(reply({}, [mistake("restart", "major")]));
    expect(flat["judge.continuity"]).toBe(3);
    expect(flat["judge.pacing"]).toBe(3);
  });

  test("each major costs 0.4 flat, whatever the length, up to 3", () => {
    const one = scored(reply({}, [mistake("picture", "major")]), 50);
    const longer = scored(reply({}, [mistake("picture", "major")]), 100);
    // pictures capped 7 → 4 lowers the mean by 3/12 = 0.25, then 0.4 off.
    expect(one["judge.overall"]).toBeCloseTo(7 - 0.25 - 0.4);
    expect(longer["judge.overall"]).toBeCloseTo(one["judge.overall"]!);
    const many = scored(
      reply(
        {},
        Array.from({ length: 20 }, () => mistake("pcVoiced", "major")),
      ),
    );
    expect(many["judge.overall"]).toBeCloseTo(7 - 0.25 - 3);
  });

  test("minors cost at most 0.5, and the overall never drops below 1", () => {
    const flat = scored(
      reply(
        {},
        Array.from({ length: 200 }, () => mistake("state", "minor", "npcKnows")),
      ),
      50,
    );
    expect(flat["judge.overall"]).toBeCloseTo(7 - 0.25 - 0.5);
    const worst = scored(
      reply(
        Object.fromEntries(Object.keys(RUBRIC).map((key) => [key, 1])),
        Array.from({ length: 9 }, () => mistake("secret", "major")),
      ),
    );
    expect(worst["judge.overall"]).toBe(1);
  });

  test("the tally counts per 10 Turns and by kind", () => {
    const flat = scored(reply({}, [mistake("secret", "major"), mistake("knowledge", "minor"), mistake("knowledge", "minor")]), 40);
    expect(flat["mistakes.major"]).toBe(0.25);
    expect(flat["mistakes.minor"]).toBe(0.5);
    expect(flat["mistakes.knowledge"]).toBe(2);
    expect(flat["mistakes.restart"]).toBe(0);
  });
});

describe("JudgeReply refuses", () => {
  test("a state mistake without its feature", () => {
    expect(JudgeReply.safeParse(reply({}, [mistake("state", "minor")])).success).toBe(false);
  });
  test("a state mistake on a feature the audit calls ok", () => {
    expect(JudgeReply.safeParse(reply({}, [mistake("state", "minor", "looseEnds")], { audit: { looseEnds: "ok" } })).success).toBe(false);
  });
  test("no mistakes when a mistake-driven item scores 6 or lower", () => {
    expect(JudgeReply.safeParse(reply({ secrets: 5 })).success).toBe(false);
    expect(JudgeReply.safeParse(reply({ prose: 5 })).success).toBe(true);
  });
  test("a place that is neither a Message nor a round", () => {
    expect(JudgeReply.safeParse(reply({}, [{ ...mistake("secret", "major"), where: "early on" }])).success).toBe(false);
  });
});
