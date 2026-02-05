#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";

const CLAUDE_DIR = path.join(process.env.HOME ?? "~", ".claude");
const API_URL = "https://claude-code-wrapped.vercel.app/api/wrapped";

// --- Types ---

interface HistoryEntry {
  display: string;
  timestamp: number;
  project?: string;
  sessionId?: string;
}

interface TranscriptEntry {
  type: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    content?: Array<{ type: string; name?: string }>;
    model?: string;
  };
}

interface FacetData {
  goal_categories?: Record<string, number>;
  outcome?: string;
  friction_counts?: Record<string, number>;
  session_id?: string;
}

interface WrappedPayload {
  stats: {
    sessions: number;
    messages: number;
    hours: number;
    days: number;
    commits: number;
  };
  tools: Record<string, number>;
  timePatterns: {
    hourDistribution: Record<string, number>;
    dayOfWeekDistribution: Record<string, number>;
    dailyActivity: Record<string, number>;
  };
  projectCount: number;
  goals: Record<string, number>;
  archetype: string;
  highlights: {
    busiestDay: string;
    busiestDayCount: number;
    longestStreak: number;
    longestSessionMinutes: number;
    firstSessionDate: string;
    topProject: string;
    rareToolName: string | null;
    rareToolCount: number | null;
  };
}

// --- Parsing ---

function readJsonlFile<T>(filePath: string): T[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as T;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is T => entry !== null);
  } catch {
    return [];
  }
}

function findJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") {
        files.push(...findJsonlFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
  return files;
}

function readFacets(): FacetData[] {
  const facetsDir = path.join(CLAUDE_DIR, "usage-data", "facets");
  try {
    const files = fs.readdirSync(facetsDir).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(facetsDir, f), "utf-8")
        ) as FacetData;
      } catch {
        return null;
      }
    }).filter((f): f is FacetData => f !== null);
  } catch {
    return [];
  }
}

// --- Computation ---

function classifyGoalFromPrompt(prompt: string): string | null {
  const lower = prompt.toLowerCase();
  if (/\b(fix|bug|broken|error|crash|issue|wrong|fail)\b/.test(lower))
    return "bug_fix";
  if (/\b(add|create|implement|build|new|feature)\b/.test(lower))
    return "feature";
  if (/\b(refactor|clean|reorganize|restructure|simplify)\b/.test(lower))
    return "refactor";
  if (/\b(deploy|ci|cd|docker|infra|devops|pipeline)\b/.test(lower))
    return "devops";
  if (/\b(doc|readme|comment|document)\b/.test(lower)) return "docs";
  if (/\b(test|spec|coverage)\b/.test(lower)) return "test";
  if (/\b(explore|understand|how does|where is|find)\b/.test(lower))
    return "explore";
  return null;
}

function scoreArchetype(payload: Omit<WrappedPayload, "archetype">): string {
  const scores: Record<string, number> = {};
  const { stats, tools, timePatterns, goals, highlights, projectCount } =
    payload;

  const avgSessionMin =
    stats.sessions > 0 ? (stats.hours * 60) / stats.sessions : 0;

  // Night Owl
  const nightHours = [22, 23, 0, 1, 2, 3];
  const nightMsgs = nightHours.reduce(
    (s, h) => s + (timePatterns.hourDistribution[String(h)] ?? 0),
    0
  );
  const totalHourMsgs = Object.values(timePatterns.hourDistribution).reduce(
    (a, b) => a + b,
    0
  );
  const nightRatio = totalHourMsgs > 0 ? nightMsgs / totalHourMsgs : 0;
  scores["night_owl"] = nightRatio > 0.4 ? 100 : nightRatio * 200;

  // Marathoner
  scores["marathoner"] =
    avgSessionMin > 45 && highlights.longestSessionMinutes > 180 ? 100 : 0;

  // Sprinter
  scores["sprinter"] =
    avgSessionMin < 10 && stats.sessions > 100 ? 100 : 0;

  // Bug Hunter
  const totalGoals = Object.values(goals).reduce((a, b) => a + b, 0) || 1;
  const bugGoals = (goals["bug_fix"] ?? 0) + (goals["debug"] ?? 0);
  scores["bug_hunter"] =
    bugGoals / totalGoals > 0.4 ? 100 : (bugGoals / totalGoals) * 200;

  // Builder
  const buildGoals =
    (goals["feature"] ?? 0) + (goals["build"] ?? 0) + (goals["create"] ?? 0);
  scores["builder"] =
    buildGoals / totalGoals > 0.4 ? 100 : (buildGoals / totalGoals) * 200;

  // Tool Master
  const toolCount = Object.keys(tools).length;
  scores["tool_master"] = toolCount >= 15 ? 100 : (toolCount / 15) * 80;

  // Delegator
  const taskUsage = tools["Task"] ?? 0;
  const taskRatio = stats.messages > 0 ? taskUsage / stats.messages : 0;
  scores["delegator"] = taskRatio > 0.1 ? 100 : taskRatio * 800;

  // Streak Master
  scores["streak_master"] =
    highlights.longestStreak >= 14
      ? 100
      : (highlights.longestStreak / 14) * 80;

  // Polyglot
  scores["polyglot"] = projectCount >= 5 ? 100 : (projectCount / 5) * 80;

  // Deep Diver
  scores["deep_diver"] =
    projectCount <= 2 && stats.sessions > 50 ? 100 : 0;

  // Explorer
  const readOps =
    (tools["Grep"] ?? 0) + (tools["Glob"] ?? 0) + (tools["Read"] ?? 0);
  const editOps = (tools["Edit"] ?? 0) + (tools["Write"] ?? 0);
  const exploreR = readOps + editOps > 0 ? readOps / (readOps + editOps) : 0;
  scores["explorer"] =
    exploreR > 0.7 && avgSessionMin < 20 ? 100 : exploreR * 80;

  // Pair Programmer
  const msgsPerSession =
    stats.sessions > 0 ? stats.messages / stats.sessions : 0;
  scores["pair_programmer"] =
    msgsPerSession > 20 ? 100 : (msgsPerSession / 20) * 80;

  return Object.entries(scores).sort(([, a], [, b]) => b - a)[0]![0];
}

function calculateLongestStreak(dailyActivity: Record<string, number>): number {
  const dates = Object.entries(dailyActivity)
    .filter(([, count]) => count > 0)
    .map(([date]) => date)
    .sort();

  if (dates.length === 0) return 0;

  let longest = 1;
  let current = 1;

  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1]!);
    const curr = new Date(dates[i]!);
    const diffDays = Math.round(
      (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (diffDays === 1) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 1;
    }
  }

  return longest;
}

// --- Main ---

function extract(): WrappedPayload {
  console.error("Reading history.jsonl...");
  const historyPath = path.join(CLAUDE_DIR, "history.jsonl");
  const history = readJsonlFile<HistoryEntry>(historyPath);

  console.error(`Found ${history.length} history entries`);

  // Track unique sessions and projects
  const sessionSet = new Set<string>();
  const projectSet = new Set<string>();
  const sessionTimestamps = new Map<string, number[]>();

  for (const entry of history) {
    if (entry.sessionId) {
      sessionSet.add(entry.sessionId);
      const timestamps = sessionTimestamps.get(entry.sessionId) ?? [];
      timestamps.push(entry.timestamp);
      sessionTimestamps.set(entry.sessionId, timestamps);
    }
    if (entry.project) {
      const projectName = path.basename(entry.project);
      if (projectName && projectName !== ".claude") {
        projectSet.add(projectName);
      }
    }
  }

  // Time patterns from history timestamps
  const hourDistribution: Record<string, number> = {};
  const dayOfWeekDistribution: Record<string, number> = {};
  const dailyActivity: Record<string, number> = {};
  let firstTimestamp = Infinity;

  for (const entry of history) {
    if (!entry.timestamp) continue;
    const date = new Date(entry.timestamp);
    firstTimestamp = Math.min(firstTimestamp, entry.timestamp);

    const hour = date.getHours();
    hourDistribution[String(hour)] =
      (hourDistribution[String(hour)] ?? 0) + 1;

    const dow = date.getDay();
    dayOfWeekDistribution[String(dow)] =
      (dayOfWeekDistribution[String(dow)] ?? 0) + 1;

    const dayKey = date.toISOString().slice(0, 10);
    dailyActivity[dayKey] = (dailyActivity[dayKey] ?? 0) + 1;
  }

  // Parse transcripts for tool usage and message counts
  console.error("Reading transcripts...");
  const projectsDir = path.join(CLAUDE_DIR, "projects");
  const transcriptFiles = findJsonlFiles(projectsDir);
  console.error(`Found ${transcriptFiles.length} transcript files`);

  const tools: Record<string, number> = {};
  let totalMessages = 0;
  let commitCount = 0;
  let longestSessionMinutes = 0;
  const projectMessageCounts: Record<string, number> = {};

  for (const file of transcriptFiles) {
    const entries = readJsonlFile<TranscriptEntry>(file);
    let sessionStart: number | null = null;
    let sessionEnd: number | null = null;

    // Derive project name from file path
    const relPath = path.relative(projectsDir, file);
    const projectDirName = relPath.split(path.sep)[0] ?? "";

    for (const entry of entries) {
      if (entry.type === "user" || entry.type === "assistant") {
        totalMessages++;

        if (projectDirName) {
          projectMessageCounts[projectDirName] =
            (projectMessageCounts[projectDirName] ?? 0) + 1;
        }
      }

      // Track session duration
      if (entry.timestamp) {
        const ts = new Date(entry.timestamp).getTime();
        if (!sessionStart || ts < sessionStart) sessionStart = ts;
        if (!sessionEnd || ts > sessionEnd) sessionEnd = ts;
      }

      // Count tool usage from assistant messages
      if (entry.type === "assistant" && entry.message) {
        const msg =
          typeof entry.message === "string"
            ? (() => {
                try {
                  return JSON.parse(entry.message);
                } catch {
                  return null;
                }
              })()
            : entry.message;

        if (msg?.content && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_use" && block.name) {
              tools[block.name] = (tools[block.name] ?? 0) + 1;

              // Count git commits
              if (block.name === "Bash") {
                const input = (block as { input?: { command?: string } })
                  .input;
                if (input?.command?.includes("git commit")) {
                  commitCount++;
                }
              }
            }
          }
        }
      }
    }

    // Calculate session duration
    if (sessionStart && sessionEnd) {
      const minutes = (sessionEnd - sessionStart) / (1000 * 60);
      longestSessionMinutes = Math.max(longestSessionMinutes, minutes);
    }
  }

  // Goals from heuristics + facets
  console.error("Computing goals...");
  const goals: Record<string, number> = {};

  // Heuristic goals from user prompts
  for (const entry of history) {
    if (entry.display) {
      const goal = classifyGoalFromPrompt(entry.display);
      if (goal) {
        goals[goal] = (goals[goal] ?? 0) + 1;
      }
    }
  }

  // Overlay LLM facets if available
  const facets = readFacets();
  for (const facet of facets) {
    if (facet.goal_categories) {
      for (const [cat, count] of Object.entries(facet.goal_categories)) {
        goals[cat] = (goals[cat] ?? 0) + count;
      }
    }
  }

  // Calculate hours from session timestamps
  let totalHours = 0;
  for (const [, timestamps] of sessionTimestamps) {
    if (timestamps.length < 2) {
      totalHours += 5 / 60; // assume 5min for single-message sessions
    } else {
      const min = Math.min(...timestamps);
      const max = Math.max(...timestamps);
      totalHours += (max - min) / (1000 * 60 * 60);
    }
  }

  // Find busiest day
  const busiestDay = Object.entries(dailyActivity).sort(
    ([, a], [, b]) => b - a
  )[0];

  // Find rarest tool (used exactly once or the least-used)
  const sortedTools = Object.entries(tools).sort(([, a], [, b]) => a - b);
  const rarest = sortedTools[0];

  // Find top project by message count
  const topProject = Object.entries(projectMessageCounts).sort(
    ([, a], [, b]) => b - a
  )[0];

  const activeDays = Object.keys(dailyActivity).filter(
    (k) => (dailyActivity[k] ?? 0) > 0
  ).length;

  const streak = calculateLongestStreak(dailyActivity);

  const payloadWithoutArchetype: Omit<WrappedPayload, "archetype"> = {
    stats: {
      sessions: sessionSet.size,
      messages: totalMessages,
      hours: Math.round(totalHours * 10) / 10,
      days: activeDays,
      commits: commitCount,
    },
    tools,
    timePatterns: {
      hourDistribution,
      dayOfWeekDistribution,
      dailyActivity,
    },
    projectCount: projectSet.size,
    goals,
    highlights: {
      busiestDay: busiestDay?.[0] ?? new Date().toISOString().slice(0, 10),
      busiestDayCount: busiestDay?.[1] ?? 0,
      longestStreak: streak,
      longestSessionMinutes: Math.round(longestSessionMinutes),
      firstSessionDate:
        firstTimestamp < Infinity
          ? new Date(firstTimestamp).toISOString().slice(0, 10)
          : new Date().toISOString().slice(0, 10),
      topProject: topProject
        ? topProject[0]!.replace(/^-Users-[^-]+-/, "")
        : "Unknown",
      rareToolName: rarest ? rarest[0] : null,
      rareToolCount: rarest ? rarest[1] : null,
    },
  };

  const archetype = scoreArchetype(payloadWithoutArchetype);

  return { ...payloadWithoutArchetype, archetype };
}

function postPayload(payload: WrappedPayload): Promise<string> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = new URL(API_URL);

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const { slug } = JSON.parse(body);
              resolve(slug);
            } catch {
              reject(new Error(`Invalid response: ${body}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main(): Promise<void> {
  console.error("Generating your Claude Code Wrapped...\n");

  const payload = extract();

  console.error(`\nStats computed:`);
  console.error(`  Sessions: ${payload.stats.sessions}`);
  console.error(`  Messages: ${payload.stats.messages}`);
  console.error(`  Hours: ${payload.stats.hours}`);
  console.error(`  Active Days: ${payload.stats.days}`);
  console.error(`  Tools Used: ${Object.keys(payload.tools).length}`);
  console.error(`  Projects: ${payload.projectCount}`);
  console.error(`  Longest Streak: ${payload.highlights.longestStreak} days`);
  console.error(`  Archetype: ${payload.archetype}\n`);

  console.error("Uploading summary...");

  try {
    const slug = await postPayload(payload);
    const url = `https://claude-code-wrapped.vercel.app/w/${slug}`;
    console.log(url);
    console.error(`\nYour Wrapped is ready! URL: ${url}`);
  } catch (err) {
    console.error("Upload failed:", err);
    console.error("\nPayload (for manual submission):");
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
}

main();
