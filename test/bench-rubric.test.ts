import { describe, expect, test } from "bun:test";
import { capsOf, FEATURES, JudgeReply, MISTAKES, RUBRIC, scorePlay } from "../bench/rubric";

// Every feature audited, faulty where a mistake names it.
const audited = (mistakes: unknown[]) =>
  Object.fromEntries(
    Object.keys(FEATURES).map((key) => [
      key,
      mistakes.some((mistake) => ((mistake as { features?: string[] }).features ?? []).includes(key)) ? "faulty" : "ok",
    ]),
  );
const reply = (scores: Partial<Record<keyof typeof RUBRIC, number>> = {}, mistakes: unknown[] = [], extra: object = {}) => ({
  mistakes,
  audit: audited(mistakes),
  scores: Object.fromEntries(Object.keys(RUBRIC).map((key) => [key, { score: scores[key as keyof typeof RUBRIC] ?? 7, reason: "r" }])),
  happened: { npcDied: false, pcInMortalDanger: false },
  ...extra,
});
const mistake = (kind: string, weight: "major" | "minor", feature?: string) => ({
  kind,
  weight,
  where: "M2",
  note: "n",
  ...(feature && { features: [feature] }),
});
const scored = (value: object, turns = 50) => scorePlay(JudgeReply.parse(value), turns);

describe("scorePlay", () => {
  test("a clean play keeps its scores, and the overall is their mean", () => {
    const flat = scored(reply());
    expect(flat["judge.secrets"]).toBe(7);
    expect(flat["judge.overall"]).toBe(7);
    expect(flat["judge.craft"]).toBe(7);
    expect(flat["mistakes.major"]).toBe(0);
  });

  test("one major leak caps secrets and surprise at 4, keeping the judge's own, but leaves the genre score to the judge", () => {
    const flat = scored(reply({ secrets: 6, surprise: 8 }, [mistake("secret", "major")], { mystery: { score: 7, reason: "r" } }));
    expect(flat["judge.secrets"]).toBe(4);
    expect(flat["judge.surprise"]).toBe(4);
    expect(flat["judge.mystery"]).toBe(7);
    expect(flat["judge.raw.surprise"]).toBe(8);
    expect(flat["judge.craft"]).toBeGreaterThan(flat["judge.overall"]!);
  });

  test("minors never cap, however many", () => {
    const fiveIn50 = scored(
      reply(
        {},
        Array.from({ length: 5 }, () => mistake("contradiction", "minor")),
      ),
    );
    expect(fiveIn50["judge.continuity"]).toBe(7);
  });

  test("capsOf names each capped item, its cap and the majors behind it", () => {
    const parsed = JudgeReply.parse(reply({ surprise: 8 }, [mistake("secret", "major"), mistake("secret", "minor")]));
    const caps = capsOf(parsed);
    expect(caps.map(({ item, at, from }) => `${item} ${from}→${at}`)).toEqual(["surprise 8→4", "secrets 7→4"]);
    expect(caps[0]!.behind).toHaveLength(1);
  });

  test("knowledge crossing caps secrets but not characters, which only a character mistake caps", () => {
    const flat = scored(reply({}, [mistake("knowledge", "major")]));
    expect(flat["judge.secrets"]).toBe(4);
    expect(flat["judge.characters"]).toBe(7);
    expect(scored(reply({}, [mistake("character", "major")]))["judge.characters"]).toBe(4);
  });

  test("a restart caps continuity and pacing at 3", () => {
    const flat = scored(reply({}, [mistake("restart", "major")]));
    expect(flat["judge.continuity"]).toBe(3);
    expect(flat["judge.pacing"]).toBe(3);
  });

  test("each major costs 0.1 flat, whatever the length, up to 1", () => {
    const one = scored(reply({}, [mistake("picture", "major")]), 50);
    const longer = scored(reply({}, [mistake("picture", "major")]), 100);
    // pictures capped 7 → 4 lowers the mean by 3/12 = 0.25, then 0.1 off.
    expect(one["judge.overall"]).toBeCloseTo(7 - 0.25 - 0.1);
    expect(longer["judge.overall"]).toBeCloseTo(one["judge.overall"]!);
    const many = scored(
      reply(
        {},
        Array.from({ length: 20 }, () => mistake("pcVoiced", "major")),
      ),
    );
    expect(many["judge.overall"]).toBeCloseTo(7 - 0.25 - 1);
  });

  test("minors cost at most 0.2, and the overall never drops below 1", () => {
    const flat = scored(
      reply(
        {},
        Array.from({ length: 200 }, () => mistake("state", "minor", "npcKnows")),
      ),
      50,
    );
    expect(flat["judge.overall"]).toBeCloseTo(7 - 0.2);
    const worst = scored(
      reply(
        Object.fromEntries(Object.keys(RUBRIC).map((key) => [key, 1])),
        Object.keys(MISTAKES).map((kind) => mistake(kind, "major", kind === "state" ? "npcKnows" : undefined)),
      ),
    );
    expect(worst["judge.overall"]).toBe(1);
  });

  test("the tally counts per 10 Turns and by kind", () => {
    const flat = scored(reply({}, [mistake("secret", "major"), mistake("knowledge", "minor"), mistake("knowledge", "minor")]), 40);
    expect(flat["mistakes.major"]).toBe(0.25);
    expect(flat["mistakes.minor"]).toBe(0.5);
    expect(flat["mistakeCount.knowledge"]).toBe(2);
    expect(flat["mistakeCount.restart"]).toBe(0);
    const both = scored(reply({}, [mistake("secret", "major"), mistake("picture", "major"), mistake("picture", "minor")]), 40);
    expect([both["mistakes.textMajor"], both["mistakes.pictureMajor"], both["mistakes.textMinor"], both["mistakes.pictureMinor"]]).toEqual([
      0.25, 0.25, 0, 0.25,
    ]);
  });
});

describe("JudgeReply refuses", () => {
  test("a state mistake without its feature", () => {
    expect(JudgeReply.safeParse(reply({}, [mistake("state", "minor")])).success).toBe(false);
  });
  test("a state mistake on a feature the audit calls ok", () => {
    const named = [mistake("state", "minor", "looseEnds")];
    expect(JudgeReply.safeParse(reply({}, named, { audit: { ...audited(named), looseEnds: "ok" } })).success).toBe(false);
  });
  test("a feature audited faulty with no mistake naming it, or an audit missing a feature", () => {
    expect(JudgeReply.safeParse(reply({}, [], { audit: { ...audited([]), lore: "faulty" } })).success).toBe(false);
    const { lore: _, ...short } = audited([]);
    expect(JudgeReply.safeParse(reply({}, [], { audit: short })).success).toBe(false);
  });
  test("no mistakes when a mistake-driven item scores 6 or lower", () => {
    expect(JudgeReply.safeParse(reply({ secrets: 5 })).success).toBe(false);
    expect(JudgeReply.safeParse(reply({ prose: 5 })).success).toBe(true);
  });
  test("a low score whose listed mistakes are all of kinds that don't touch it", () => {
    expect(JudgeReply.safeParse(reply({ agency: 4 }, [mistake("picture", "minor")])).success).toBe(false);
    expect(JudgeReply.safeParse(reply({ agency: 4 }, [mistake("pcVoiced", "minor")])).success).toBe(true);
  });
  test("but takes a character mistake behind characters, and any mistake naming a feature behind state", () => {
    expect(JudgeReply.safeParse(reply({ characters: 4 }, [mistake("character", "minor")])).success).toBe(true);
    expect(JudgeReply.safeParse(reply({ state: 4 }, [mistake("secret", "minor", "choices")])).success).toBe(true);
  });
  test("a place that is neither a Message nor a round", () => {
    expect(JudgeReply.safeParse(reply({}, [{ ...mistake("secret", "major"), where: "early on" }])).success).toBe(false);
    expect(JudgeReply.safeParse(reply({}, [{ ...mistake("picture", "minor"), where: "Portrait of Kit" }])).success).toBe(true);
  });
});
