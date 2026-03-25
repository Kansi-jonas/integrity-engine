export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAutoSync } = await import("@/lib/auto-sync");
    startAutoSync();
  }
}
