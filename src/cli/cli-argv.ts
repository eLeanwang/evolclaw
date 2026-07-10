export function normalizeCliArgv(argv: string[]): string[] {
  if ((argv[0] === 'ec' || argv[0] === 'evolclaw') && argv[1]) return argv.slice(1);
  return argv;
}
