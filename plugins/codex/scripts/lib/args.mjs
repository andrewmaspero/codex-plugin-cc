// A token only counts as a flag when it looks like one (`-x`, `--foo`);
// bare `-`, negative numbers, and prose fragments stay positional.
const FLAG_PATTERN = /^-{1,2}[A-Za-z]/;

function rejectUnknownFlag(token) {
  throw new Error(
    `Unknown flag "${token}" for this command. Run the command with --help to list supported flags, or put prose that starts with a dash after a bare "--" separator.`
  );
}

export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const strict = Boolean(config.strict);
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      if (strict && FLAG_PATTERN.test(token)) {
        rejectUnknownFlag(token);
      }
      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    if (strict && FLAG_PATTERN.test(token)) {
      rejectUnknownFlag(token);
    }
    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  const characters = [...raw];
  let current = "";
  let quote = null;
  let escaping = false;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        // A bare `--` switches to passthrough: the rest of the raw string is
        // prose (steer corrections, goal objectives) and must keep its
        // quotes, apostrophes, and backslashes verbatim.
        if (current === "--") {
          tokens.push("--");
          const remainder = characters.slice(index + 1).join("").trim();
          if (remainder) {
            tokens.push(remainder);
          }
          return tokens;
        }
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
