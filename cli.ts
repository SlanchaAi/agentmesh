#!/usr/bin/env bun
/**
 * agentmesh CLI
 *
 * Utility for inspecting and interacting with the agentmesh broker.
 *
 * Usage:
 *   bun cli.ts status                       — Broker health + all agents
 *   bun cli.ts agents [--fleet F] [--online] — List agents
 *   bun cli.ts send <agent-id> <message>    — Send a direct message
 *   bun cli.ts broadcast <topic> <message>  — Publish to a topic
 *   bun cli.ts dead-letters [agent-id]      — Show dead letter queue
 *
 * Config (env or defaults):
 *   AGENTMESH_BROKER_URL  — default http://127.0.0.1:7899
 */

const BROKER_URL = process.env.AGENTMESH_BROKER_URL ?? "http://127.0.0.1:7899";

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : { method: "GET" };
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

function fmtAgent(a: any): string {
  const lines: string[] = [];
  const addr = [a.fleet_id, a.device_id, a.agent_name].filter(Boolean).join("/") || a.id;
  const onlineTag = a.online ? " \x1b[32m●\x1b[0m" : " \x1b[90m○\x1b[0m";
  lines.push(`  ${a.id}${onlineTag}  [${a.agent_type}]  ${addr}`);
  if (a.summary) lines.push(`    ${a.summary}`);
  const meta: string[] = [];
  if (a.hostname) meta.push(`host:${a.hostname}`);
  if (a.cwd) meta.push(`cwd:${a.cwd}`);
  if (a.capabilities?.length) meta.push(`caps:${a.capabilities.join(",")}`);
  meta.push(`seen:${new Date(a.last_seen).toLocaleString()}`);
  lines.push(`    ${meta.join("  ")}`);
  return lines.join("\n");
}

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; agents?: number; peers?: number }>("/health");
      const count = health.agents ?? health.peers ?? 0;
      console.log(`Broker: \x1b[32m${health.status}\x1b[0m  (${count} agent(s))  ${BROKER_URL}`);

      if (count > 0) {
        const agents = await brokerFetch<any[]>("/list-peers", { scope: "fleet", cwd: "/", git_root: null });
        if (agents.length) {
          console.log("\nAgents:");
          for (const a of agents) console.log(fmtAgent(a));
        }
      }
    } catch (e) {
      console.error(`Broker unreachable at ${BROKER_URL}: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    break;
  }

  case "agents": {
    // Parse flags: --fleet <id>, --device <id>, --online, --type <type>
    const flags: Record<string, string | boolean> = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--fleet") flags.fleet_id = rest[++i];
      else if (rest[i] === "--device") flags.device_id = rest[++i];
      else if (rest[i] === "--type") flags.agent_type = rest[++i];
      else if (rest[i] === "--online") flags.online_only = true;
    }
    try {
      const agents = await brokerFetch<any[]>("/list-peers", {
        scope: "fleet",
        cwd: "/",
        git_root: null,
        ...flags,
      });
      if (!agents.length) {
        console.log("No agents found.");
      } else {
        console.log(`${agents.length} agent(s):\n`);
        for (const a of agents) console.log(fmtAgent(a));
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    break;
  }

  case "send": {
    const [toId, ...msgParts] = rest;
    const msg = msgParts.join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <agent-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
        qos: 1,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    break;
  }

  case "broadcast": {
    const [topic, ...msgParts] = rest;
    const msg = msgParts.join(" ");
    if (!topic || !msg) {
      console.error("Usage: bun cli.ts broadcast <topic> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; delivered_to?: string[]; error?: string }>("/broadcast", {
        from_id: "cli",
        topic,
        text: msg,
        qos: 1,
      });
      if (result.ok) {
        console.log(`Broadcast to "${topic}" — ${result.delivered_to?.length ?? 0} recipient(s)`);
      } else {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    break;
  }

  case "dead-letters": {
    const agentId = rest[0];
    if (!agentId) {
      console.error("Usage: bun cli.ts dead-letters <agent-id>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ dead_letters: any[] }>("/dead-letters", { id: agentId, limit: 50 });
      if (!result.dead_letters.length) {
        console.log("No dead letters.");
      } else {
        for (const d of result.dead_letters) {
          console.log(`  From ${d.from_id}${d.topic ? ` [${d.topic}]` : ""} — ${d.reason} (${d.failed_at})`);
          console.log(`    ${d.text}`);
        }
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    break;
  }

  default:
    console.log(`agentmesh CLI

Usage:
  bun cli.ts status                         Broker health + all agents
  bun cli.ts agents [--fleet F] [--online]  List agents (flags: --fleet, --device, --type, --online)
  bun cli.ts send <agent-id> <message>      Send a direct message
  bun cli.ts broadcast <topic> <message>    Publish to a topic
  bun cli.ts dead-letters <agent-id>        Show dead letter queue

Config:
  AGENTMESH_BROKER_URL  Broker URL (default: http://127.0.0.1:7899)`);
}
