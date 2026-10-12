// A host CLI that wraps this one (Feynman runs it as `feynman alpha`) sets
// ALPHA_HUB_CLI so login hints name the command the user actually has.
export function cliCommand(subcommand) {
  return `${process.env.ALPHA_HUB_CLI || 'alpha'} ${subcommand}`;
}
