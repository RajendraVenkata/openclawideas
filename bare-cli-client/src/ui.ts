// Lightweight terminal UI: readline input loop + ANSI colors. Incoming lines are
// printed ABOVE the input line without clobbering what you're typing.
import readline from "node:readline";

const C = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  grey: "\x1b[90m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

export type Ui = {
  question: (q: string) => Promise<string>;
  print: (line: string) => void;
  printYou: (name: string, text: string) => void;
  printAgent: (text: string) => void;
  printSystem: (text: string) => void;
  printError: (text: string) => void;
  startChat: (onLine: (line: string) => void) => void;
  close: () => void;
};

export function createUi(): Ui {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Exit cleanly when stdin closes (Ctrl-D / EOF / killed) instead of throwing
  // ERR_USE_AFTER_CLOSE from a pending question.
  rl.on("close", () => process.exit(0));

  // Print a line above the current input, then redraw the prompt + typed text.
  function printAbove(line: string): void {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(line + "\n");
    const refresh = (rl as unknown as { _refreshLine?: () => void })._refreshLine;
    if (typeof refresh === "function") refresh.call(rl);
  }

  return {
    question: (q) => new Promise<string>((resolve) => rl.question(`${C.yellow}${q}${C.reset}`, resolve)),
    print: (line) => printAbove(line),
    printYou: (name, text) => printAbove(`${C.cyan}${name}${C.reset} ${text}`),
    printAgent: (text) => printAbove(`${C.green}agent${C.reset} ${text}`),
    printSystem: (text) => printAbove(`${C.grey}· ${text}${C.reset}`),
    printError: (text) => printAbove(`${C.red}✗ ${text}${C.reset}`),
    startChat: (onLine) => {
      rl.setPrompt(`${C.bold}>${C.reset} `);
      rl.prompt();
      rl.on("line", (line) => {
        onLine(line);
        rl.prompt();
      });
    },
    close: () => rl.close(),
  };
}
