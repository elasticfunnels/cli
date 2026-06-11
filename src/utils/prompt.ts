import * as readline from 'readline';

/**
 * Minimal interactive-prompt helpers. We deliberately do NOT pull in
 * `inquirer` or `prompts` to keep the CLI dep tree small — these helpers
 * are enough for our login flow and any other Y/N choices.
 */

export async function ask(question: string, opts: { default?: string; mask?: boolean } = {}): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    try {
        if (opts.mask) {
            // Mask input as the user types — used for API keys. We disable
            // readline's echo and write * for each keystroke ourselves.
            return await readMasked(rl, question, opts.default);
        }
        return await new Promise<string>((resolve) => {
            const suffix = opts.default ? ` [${opts.default}]` : '';
            rl.question(`${question}${suffix}: `, (answer) => {
                const trimmed = answer.trim();
                resolve(trimmed.length === 0 && opts.default ? opts.default : trimmed);
            });
        });
    } finally {
        rl.close();
    }
}

async function readMasked(rl: readline.Interface, question: string, defValue?: string): Promise<string> {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw === true;
        const buffer: string[] = [];
        const suffix = defValue ? ` [${defValue}]` : '';
        process.stderr.write(`${question}${suffix}: `);
        if (typeof stdin.setRawMode === 'function') {
            stdin.setRawMode(true);
        }
        stdin.resume();
        stdin.setEncoding('utf8');
        const onData = (chunk: string) => {
            for (const ch of chunk) {
                const code = ch.charCodeAt(0);
                if (code === 3) { // Ctrl-C
                    process.stderr.write('\n');
                    process.exit(130);
                }
                if (code === 13 || code === 10) { // Enter
                    process.stderr.write('\n');
                    cleanup();
                    const value = buffer.join('');
                    resolve(value.length === 0 && defValue ? defValue : value);
                    return;
                }
                if (code === 127 || code === 8) { // Backspace
                    if (buffer.length > 0) {
                        buffer.pop();
                        process.stderr.write('\b \b');
                    }
                    continue;
                }
                if (code < 32) {
                    // ignore other control chars
                    continue;
                }
                buffer.push(ch);
                process.stderr.write('*');
            }
        };
        const cleanup = () => {
            stdin.removeListener('data', onData);
            if (typeof stdin.setRawMode === 'function') {
                stdin.setRawMode(wasRaw);
            }
            stdin.pause();
            rl.close();
        };
        stdin.on('data', onData);
    });
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    try {
        const suffix = defaultYes ? ' [Y/n]' : ' [y/N]';
        return await new Promise<boolean>((resolve) => {
            rl.question(`${question}${suffix}: `, (answer) => {
                const a = answer.trim().toLowerCase();
                if (a === '') return resolve(defaultYes);
                return resolve(a === 'y' || a === 'yes');
            });
        });
    } finally {
        rl.close();
    }
}

export async function pickOne<T>(label: string, choices: Array<{ name: string; value: T }>): Promise<T> {
    if (choices.length === 0) throw new Error('pickOne called with no choices');
    if (choices.length === 1) return choices[0].value;
    process.stderr.write(`${label}\n`);
    choices.forEach((c, i) => {
        process.stderr.write(`  ${String(i + 1).padStart(2)}. ${c.name}\n`);
    });
    const answer = await ask('Select a number', { default: '1' });
    const idx = parseInt(answer, 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > choices.length) {
        throw new Error(`Invalid selection: ${answer}`);
    }
    return choices[idx - 1].value;
}
