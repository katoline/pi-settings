import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Adds /clear: discard the current conversation and start a fresh session (same as the built-in /new). */
export default function clearExtension(pi: ExtensionAPI): void {
  pi.registerCommand("clear", {
    description: "Clear the conversation and start a new session (same as /new)",
    handler: async (_args, ctx) => {
      // Wait for the running turn to finish before swapping the session.
      await ctx.waitForIdle();
      const result = await ctx.newSession();
      if (result.cancelled) ctx.ui.notify("/clear was cancelled by an extension.", "warning");
    },
  });
}
