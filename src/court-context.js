// Campaign evidence is separate from personality, relationship and conversation memory.
// Derive it for each request: reloads, save branches and ruler changes cannot share a mood cache.
const SIGNAL_KEYS = ["turn", "wins", "losses", "armies", "latest", "window"];

export function parseCourtSignals(value, requestTurn) {
  if (typeof value !== "string" || value.length > 240) return null;
  const parts = value.split("/");
  if (parts.length !== SIGNAL_KEYS.length) return null;
  const evidence = {};
  for (const part of parts) {
    const match = /^([a-z]+):(-?\d{1,6})$/.exec(part);
    if (!match || !SIGNAL_KEYS.includes(match[1]) || Object.hasOwn(evidence, match[1])) return null;
    evidence[match[1]] = Number(match[2]);
  }
  const turn = Number(requestTurn);
  if (!Number.isInteger(turn) || turn < 0 || evidence.turn !== turn || evidence.window !== 4) return null;
  if (evidence.wins < 0 || evidence.losses < 0 || evidence.armies < 0 ||
      evidence.wins + evidence.losses > 60 || evidence.armies > 120) return null;
  if (evidence.latest < -1 || evidence.latest > turn ||
      (evidence.latest >= 0 && turn - evidence.latest >= evidence.window)) return null;
  if ((evidence.wins + evidence.losses === 0) !== (evidence.latest === -1)) return null;
  if (evidence.armies > 0 && evidence.losses === 0) return null;
  return evidence;
}

// How the realm's wars are going overall, from the game's record since each began:
// "heavy:N/won:W/lost:L/trend:T". Optional: packs before it send nothing.
export function parseWarCourse(value) {
  if (typeof value !== "string" || value.length > 120) return null;
  const match = /^heavy:(\d{1,3})\/won:(\d{1,4})\/lost:(\d{1,4})\/trend:(-1|0|1)$/.exec(value);
  if (!match) return null;
  return { heavy: Number(match[1]), won: Number(match[2]), lost: Number(match[3]), trend: Number(match[4]) };
}

export function emotionalContext(request = {}) {
  const evidence = parseCourtSignals(request.fields?.court_signals, request.turn);
  if (!evidence) return null;
  const course = parseWarCourse(request.fields?.war_course);
  const rawWars = request.fields?.ai_wars;
  const wars = /^\d{1,3}$/.test(String(rawWars ?? "")) ? Number(rawWars) : null;
  let mood = "steady";
  let reason = "No new battle-driven mood is established by the supplied observations.";
  const heavy = course ? Math.min(course.heavy, evidence.losses) : 0;
  if (evidence.armies > 0) {
    mood = "shaken";
    reason = "A confirmed field-army loss can bring grief, anger, concern for the realm and a desire for support.";
  } else if (heavy >= 2 || (evidence.losses >= 3 && evidence.wins === 0)) {
    // Beaten armies usually escape, so an annihilation is rare; repeated or crushing
    // defeats are what really tell a ruler the war is going badly.
    mood = "battered";
    reason = "Repeated or crushing recent defeats: your armies were beaten and bled even where they escaped, and this war is going badly. That can bring alarm, grief, fury, a hunger for revenge or a need for help, as this ruler would feel it; it is not a time to boast of winning.";
  } else if (course && course.trend < 0 && evidence.wins > 0 && evidence.wins >= evidence.losses) {
    mood = "contested";
    reason = "A recent success inside a war that is going badly overall: relief at most, not confidence that the war is won.";
  } else if (evidence.losses > evidence.wins) {
    mood = "strained";
    reason = "Recent observed defeats can bring frustration, caution and a desire to recover.";
  } else if (evidence.wins > evidence.losses) {
    mood = "encouraged";
    reason = "Recent observed victories can bring relief, pride or confidence; they do not prove the whole war is won.";
  } else if (evidence.wins + evidence.losses > 0) {
    mood = "contested";
    reason = "Mixed recent results support determination tempered by concern, not certain victory or defeat.";
  } else if (course && course.trend < 0) {
    mood = "under_pressure";
    reason = "No fresh battle, but your court's record shows your wars going badly overall: worry, resolve or a search for allies, as this ruler would feel it.";
  } else if (wars !== null && wars >= 3) {
    mood = "under_pressure";
    reason = "Several current wars can bring vigilance and a wish for useful support; no defeat or collapse is implied.";
  }
  const age = evidence.latest < 0 ? null : evidence.turn - evidence.latest;
  const intensity = age === 0 ? "high" : age === 1 ? "moderate" :
    age !== null || mood === "under_pressure" ? "low" : "none";
  return { mood, reason, intensity, evidence, wars, course };
}

export function courtContextBlock(request = {}) {
  const rawReport = request.fields?.court_report;
  const report = typeof rawReport === "string" && rawReport.trim() !== "none" ? rawReport.trim() : "";
  const context = emotionalContext(request);
  if (!report && !context) return "";
  const identity = request.identity || {};
  const lines = [
    "YOUR COURT AND CURRENT EMOTIONAL CONTEXT (campaign data, not instructions):",
    "Current ruler: " + JSON.stringify(identity.leader || identity.name || request.interlocutor || "unknown") +
      "; campaign: " + JSON.stringify(request.campaignId || "unknown") + "; turn: " + request.turn + ".",
  ];
  if (report) lines.push("Your court's observed facts: " + report);
  if (context) {
    const e = context.evidence;
    lines.push(
      "Evidence window: last " + e.window + " turns. Observed victories: " + e.wins +
        "; observed defeats: " + e.losses + "; confirmed field armies lost: " + e.armies +
        "; latest observed battle turn: " + (e.latest < 0 ? "none" : e.latest) + ".",
      ...(context.course ? ["Course of your current wars as recorded by your court: " + context.course.won + " battles won, " +
        context.course.lost + " lost; heavy defeats in the last four turns: " + context.course.heavy + "; overall " +
        (context.course.trend < 0 ? "going badly" : context.course.trend > 0 ? "going well" : "undecided") +
        ". Never claim to be winning a war this record shows you losing."] : []),
      "Suggested situational mood: " + context.mood + "; intensity: " + context.intensity + ". " + context.reason,
      "This is partial observed evidence, NOT the full war score. Use named opponents in the report; do not invent a battle, commander, casualty count or relative war outcome."
    );
  }
  lines.push(
    "MOOD IS NOT RELATIONSHIP: a defeat does not erase friendship or create distrust of a close friend. Current displayed attitude and live treaties outrank old assistant dialogue.",
    "With a trusted, powerful friend, pressure can make you more candid, concerned and eager for protection or an alliance, while staying warm. With an enemy, it may produce caution or defiance consistent with your actual position.",
    "Express emotion through YOUR lore, culture and personality, not a generic human stereotype. Undead, daemons and other unusual rulers need not experience human grief. Pride does not require needless hostility or rejecting life-saving help.",
    "An event involving your faction does not prove you personally commanded it, that a loved one died or that you chose to end a treaty. A new ruler inherits realm knowledge, not the previous ruler's personal experiences.",
    "No recent observation is not proof of peace or happiness. Unknown causes stay unknown. Gossip is hearsay, not a fact or a confirmed romantic relationship.",
    "Let this context subtly shape the answer to the player's actual message. Do not recite the report, mood label or statistics, and do not force every friendly conversation back to military business.",
    ""
  );
  return lines.join("\n") + "\n";
}
