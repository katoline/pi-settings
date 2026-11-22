import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Adds /exit as an alias of the built-in /quit. */
export default function exitExtension(pi: ExtensionAPI): void {
  pi.registerCommand("exit", {
    description: "Quit pi (same as /quit)",
    handler: async (_args, ctx) => {
      // Runs the same shutdown as /quit. While the agent is busy, pi waits until it is idle.
      ctx.shutdown();
    },
  });
}
