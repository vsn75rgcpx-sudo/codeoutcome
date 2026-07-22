import type {
  GitChangeSummary,
  LinkConfidenceLevel,
  Session,
  TrackingRun,
} from "@codeoutcome/shared";

export const SESSION_LINK_SCORING = {
  weights: {
    provider: 0.15,
    repository: 0.2,
    workingDirectory: 0.2,
    overlap: 0.2,
    startProximity: 0.1,
    endProximity: 0.05,
    branch: 0.05,
    uniqueCandidate: 0.05,
  },
  penalties: {
    branchChanged: 0.1,
    historyRewrittenOrRewound: 0.15,
  },
  proximityWindowMs: 30 * 60 * 1_000,
  candidateMinimum: 0.35,
  autoLinkMinimum: 0.65,
  ambiguityMargin: 0.05,
  highThreshold: 0.85,
  mediumThreshold: 0.65,
  lowThreshold: 0.45,
} as const;

export interface SessionLinkCandidate {
  sessionId: string;
  score: number;
  reasons: string[];
}

export interface SessionLinkDecision {
  sessionId: string | null;
  score: number;
  confidenceLevel: LinkConfidenceLevel;
  reasons: string[];
  candidates: SessionLinkCandidate[];
}

function timestamp(value: string | null): number | null {
  if (value === null) return null;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function addReason(
  reasons: string[],
  label: string,
  contribution: number,
): number {
  if (contribution > 0) {
    reasons.push(`${label} (+${contribution.toFixed(3)})`);
  }
  return contribution;
}

function proximityContribution(
  left: number,
  right: number,
  weight: number,
): number {
  const distance = Math.abs(left - right);
  if (distance > SESSION_LINK_SCORING.proximityWindowMs) return 0;
  return weight * (1 - distance / SESSION_LINK_SCORING.proximityWindowMs);
}

function baseCandidate(
  run: TrackingRun,
  session: Session,
  trackingBranch: string | null,
): SessionLinkCandidate {
  const reasons: string[] = [];
  let score = 0;
  if (session.provider === run.provider) {
    score += addReason(
      reasons,
      "provider matched",
      SESSION_LINK_SCORING.weights.provider,
    );
  }
  if (
    session.repositoryPath !== null &&
    session.repositoryPath === run.repositoryPath
  ) {
    score += addReason(
      reasons,
      "canonical repository matched",
      SESSION_LINK_SCORING.weights.repository,
    );
  }
  if (
    session.workingDirectory !== null &&
    session.workingDirectory === run.workingDirectory
  ) {
    score += addReason(
      reasons,
      "working directory matched",
      SESSION_LINK_SCORING.weights.workingDirectory,
    );
  }
  if (
    session.branch !== null &&
    trackingBranch !== null &&
    session.branch === trackingBranch
  ) {
    score += addReason(
      reasons,
      "branch matched",
      SESSION_LINK_SCORING.weights.branch,
    );
  }

  const runStart = timestamp(run.startedAt);
  const runEnd = timestamp(run.endedAt);
  const sessionStart = timestamp(session.startedAt);
  const sessionEnd = timestamp(session.endedAt);
  if (
    runStart !== null &&
    runEnd !== null &&
    sessionStart !== null &&
    sessionEnd !== null &&
    runEnd >= runStart &&
    sessionEnd >= sessionStart
  ) {
    const overlap = Math.max(
      0,
      Math.min(runEnd, sessionEnd) - Math.max(runStart, sessionStart),
    );
    const runDuration = Math.max(1, runEnd - runStart);
    const ratio = Math.min(1, overlap / runDuration);
    score += addReason(
      reasons,
      `session overlap ${(ratio * 100).toFixed(1)}%`,
      SESSION_LINK_SCORING.weights.overlap * ratio,
    );
    score += addReason(
      reasons,
      "session start proximity",
      proximityContribution(
        runStart,
        sessionStart,
        SESSION_LINK_SCORING.weights.startProximity,
      ),
    );
    score += addReason(
      reasons,
      "session end proximity",
      proximityContribution(
        runEnd,
        sessionEnd,
        SESSION_LINK_SCORING.weights.endProximity,
      ),
    );
  } else if (runStart !== null && sessionStart !== null) {
    score += addReason(
      reasons,
      "session start proximity",
      proximityContribution(
        runStart,
        sessionStart,
        SESSION_LINK_SCORING.weights.startProximity,
      ),
    );
  }

  return { sessionId: session.id, score, reasons };
}

function level(score: number): LinkConfidenceLevel {
  if (score >= SESSION_LINK_SCORING.highThreshold) return "high";
  if (score >= SESSION_LINK_SCORING.mediumThreshold) return "medium";
  return "low";
}

export function scoreSessionLink(
  run: TrackingRun,
  sessions: readonly Session[],
  summary: GitChangeSummary | null = run.summary,
  trackingBranch: string | null = null,
): SessionLinkDecision {
  const base = sessions
    .filter((session) => session.provider === run.provider)
    .map((session) => baseCandidate(run, session, trackingBranch))
    .filter(
      (candidate) => candidate.score >= SESSION_LINK_SCORING.candidateMinimum,
    );
  for (const candidate of base) {
    if (summary?.branchChanged === true) {
      candidate.score = Math.max(
        0,
        candidate.score - SESSION_LINK_SCORING.penalties.branchChanged,
      );
      candidate.reasons.push(
        `branch changed (-${SESSION_LINK_SCORING.penalties.branchChanged.toFixed(3)})`,
      );
    }
    if (summary?.warnings.includes("head_rewritten_or_rewound") === true) {
      candidate.score = Math.max(
        0,
        candidate.score -
          SESSION_LINK_SCORING.penalties.historyRewrittenOrRewound,
      );
      candidate.reasons.push(
        `history rewritten or rewound (-${SESSION_LINK_SCORING.penalties.historyRewrittenOrRewound.toFixed(3)})`,
      );
    }
  }
  if (base.length === 1 && base[0] !== undefined) {
    base[0].score += SESSION_LINK_SCORING.weights.uniqueCandidate;
    base[0].reasons.push(
      `only viable candidate (+${SESSION_LINK_SCORING.weights.uniqueCandidate.toFixed(3)})`,
    );
  }
  const candidates = base.sort(
    (left, right) =>
      right.score - left.score || left.sessionId.localeCompare(right.sessionId),
  );
  const first = candidates[0];
  if (first === undefined) {
    return {
      sessionId: null,
      score: 0,
      confidenceLevel: "low",
      reasons: ["no candidate met the minimum evidence threshold"],
      candidates,
    };
  }
  const second = candidates[1];
  if (
    first.score >= SESSION_LINK_SCORING.autoLinkMinimum &&
    second !== undefined &&
    second.score >= SESSION_LINK_SCORING.autoLinkMinimum &&
    first.score - second.score <= SESSION_LINK_SCORING.ambiguityMargin
  ) {
    return {
      sessionId: null,
      score: first.score,
      confidenceLevel: "ambiguous",
      reasons: [
        "multiple candidates have scores within the configured ambiguity margin",
      ],
      candidates,
    };
  }

  let score = Math.min(1, first.score);
  const reasons = [...first.reasons];
  let confidenceLevel = level(score);
  if (summary?.baselineDirty === true && confidenceLevel === "high") {
    score = Math.min(score, SESSION_LINK_SCORING.highThreshold - 0.01);
    confidenceLevel = "medium";
    reasons.push("dirty baseline caps automatic confidence at medium");
  }
  if (score < SESSION_LINK_SCORING.autoLinkMinimum) {
    reasons.push("score is below the automatic link threshold");
    return {
      sessionId: null,
      score,
      confidenceLevel,
      reasons,
      candidates,
    };
  }
  return {
    sessionId: first.sessionId,
    score,
    confidenceLevel,
    reasons,
    candidates,
  };
}
