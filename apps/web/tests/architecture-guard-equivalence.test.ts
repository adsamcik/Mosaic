import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..', '..');

type GuardPair = {
  name: string;
  ps1: string;
  sh: string;
  checks: Array<{
    label: string;
    ps: (source: string) => string[];
    sh: (source: string) => string[];
  }>;
};

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function quotedValues(source: string): string[] {
  const values: string[] = [];
  const stringPattern = /['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(stringPattern)) {
    values.push(match[1]);
  }
  return values;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function symmetricDifference(left: string[], right: string[]): string[] {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return uniqueSorted([
    ...left.filter((value) => !rightSet.has(value)).map((value) => `ps1-only:${value}`),
    ...right.filter((value) => !leftSet.has(value)).map((value) => `sh-only:${value}`),
  ]);
}

function psArray(variableName: string): (source: string) => string[] {
  return (source: string): string[] => {
    const match = new RegExp(`\\$${variableName}\\s*=\\s*@\\((?<body>[\\s\\S]*?)\\)`).exec(source);
    return match?.groups?.body ? uniqueSorted(quotedValues(match.groups.body)) : [];
  };
}

function bashArray(variableName: string): (source: string) => string[] {
  return (source: string): string[] => {
    const match = new RegExp(`${variableName}\\s*=\\s*\\((?<body>[\\s\\S]*?)\\n\\)`).exec(source);
    if (!match?.groups?.body) return [];
    const quoted = quotedValues(match.groups.body);
    if (quoted.length > 0) return uniqueSorted(quoted);
    return uniqueSorted(
      match.groups.body
        .split(/\r?\n/)
        .map((line) => line.replace(/#.*$/, '').trim())
        .filter(Boolean),
    );
  };
}

function pythonSequence(variableName: string): (source: string) => string[] {
  return (source: string): string[] => {
    const match = new RegExp(`${variableName}\\s*=\\s*(?:\\[(?<list>[\\s\\S]*?)\\]|\\{(?<set>[\\s\\S]*?)\\})`).exec(source);
    const body = match?.groups?.list ?? match?.groups?.set;
    return body ? uniqueSorted(quotedValues(body)) : [];
  };
}

function psHashtableKeys(variableName: string): (source: string) => string[] {
  return (source: string): string[] => {
    const match = new RegExp(`\\$${variableName}\\s*=\\s*@\\{(?<body>[\\s\\S]*?)\\n\\}`).exec(source);
    if (!match?.groups?.body) return [];
    return uniqueSorted([...match.groups.body.matchAll(/^\s*['"]([^'"]+)['"]\s*=/gm)].map((entry) => entry[1]));
  };
}

function pythonDictKeys(variableName: string): (source: string) => string[] {
  return (source: string): string[] => {
    const match = new RegExp(`${variableName}\\s*=\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`).exec(source);
    if (!match?.groups?.body) return [];
    return uniqueSorted([...match.groups.body.matchAll(/^\s*['"]([^'"]+)['"]\s*:/gm)].map((entry) => entry[1]));
  };
}

function psScalar(variableName: string): (source: string) => string[] {
  return (source: string): string[] => {
    const match = new RegExp(`\\$${variableName}\\s*=\\s*['"](?<value>[^'"]+)['"]`).exec(source);
    return match?.groups?.value ? [match.groups.value] : [];
  };
}

function bashScalar(variableName: string): (source: string) => string[] {
  return (source: string): string[] => {
    const match = new RegExp(`${variableName}\\s*=\\s*['"](?<value>[^'"]+)['"]`).exec(source);
    return match?.groups?.value ? [match.groups.value] : [];
  };
}

function normalizeRegex(value: string): string {
  return value.replace(/\\\./g, '.');
}

function psPatternRegexes(source: string): string[] {
  return uniqueSorted([...source.matchAll(/Regex\s*=\s*'([^']+)'/g)].map((entry) => normalizeRegex(entry[1])));
}

function bashCaseRegexes(source: string): string[] {
  return uniqueSorted([...source.matchAll(/printf '%s' '([^']+)'/g)].map((entry) => normalizeRegex(entry[1])));
}

function bashPatternRegexes(source: string): string[] {
  const match = /PATTERN_REGEXES\s*=\s*\((?<body>[\s\S]*?)\n\)/.exec(source);
  return match?.groups?.body ? uniqueSorted(quotedValues(match.groups.body).map(normalizeRegex)) : [];
}

function bashAssocKeys(variableName: string): (source: string) => string[] {
  return (source: string): string[] => {
    const match = new RegExp(`declare\\s+-A\\s+${variableName}\\s*=\\s*\\((?<body>[\\s\\S]*?)\\n\\)`).exec(source);
    if (!match?.groups?.body) return [];
    return uniqueSorted([...match.groups.body.matchAll(/\[\s*['"]([^'"]+)['"]\s*\]=/g)].map((entry) => entry[1]));
  };
}

function psPatternNames(source: string): string[] {
  return uniqueSorted([...source.matchAll(/Name\s*=\s*'([^']+)'/g)].map((entry) => entry[1]));
}

function psHighRiskTargets(source: string): string[] {
  const match = /\$HighRiskTargets\s*=\s*@\((?<body>[\s\S]*?)\n\)/.exec(source);
  if (!match?.groups?.body) return [];
  return uniqueSorted(
    [...match.groups.body.matchAll(/@\{\s*Path\s*=\s*'([^']+)';\s*Recurse\s*=\s*\$(true|false);\s*Filter\s*=\s*(?:'([^']+)'|\$null)\s*\}/gi)]
      .map((entry) => `${entry[1]}|${entry[2].toLowerCase() === 'true' ? '1' : '0'}|${entry[3] ?? '*'}`),
  );
}

const guardPairs: GuardPair[] = [
  {
    name: 'no-raw-secret-ffi-export',
    ps1: 'tests/architecture/no-raw-secret-ffi-export.ps1',
    sh: 'tests/architecture/no-raw-secret-ffi-export.sh',
    checks: [
      { label: 'forbidden raw bundle APIs', ps: psArray('forbiddenRawBundleApis'), sh: pythonSequence('forbidden_raw_bundle_apis') },
      { label: 'forbidden legacy d.ts functions', ps: psArray('forbiddenLegacyDtsFunctions'), sh: pythonSequence('forbidden_legacy_dts_functions') },
      { label: 'allowlist keys', ps: psHashtableKeys('allowlist'), sh: pythonDictKeys('allowlist') },
      { label: 'struct field allowlist keys', ps: psHashtableKeys('structFieldAllowlist'), sh: pythonDictKeys('struct_field_allowlist') },
      { label: 'd.ts allowlist keys', ps: psHashtableKeys('dtsAllowlist'), sh: pythonDictKeys('dts_allowlist') },
    ],
  },
  {
    name: 'web-raw-input-ffi',
    ps1: 'tests/architecture/web-raw-input-ffi.ps1',
    sh: 'tests/architecture/web-raw-input-ffi.sh',
    checks: [
      { label: 'forbidden names', ps: psArray('ForbiddenNames'), sh: pythonSequence('forbidden_names') },
      { label: 'allowlist keys', ps: psHashtableKeys('AllowlistedFiles'), sh: pythonDictKeys('allowlisted_files') },
    ],
  },
  {
    name: 'kotlin-raw-input-ffi',
    ps1: 'tests/architecture/kotlin-raw-input-ffi.ps1',
    sh: 'tests/architecture/kotlin-raw-input-ffi.sh',
    checks: [
      { label: 'allowed fixture emails', ps: psArray('AllowedFixtureEmails'), sh: bashArray('ALLOWED_FIXTURE_EMAILS') },
      { label: 'email roots', ps: psArray('PiiEmailRoots'), sh: bashArray('PII_EMAIL_ROOTS') },
      { label: 'production PII roots', ps: psArray('PiiProductionRoots'), sh: bashArray('PII_PRODUCTION_ROOTS') },
      { label: 'email regex', ps: psScalar('PiiEmailRegex'), sh: bashScalar('PII_EMAIL_REGEX') },
      { label: 'phone regex', ps: psScalar('PiiPhoneRegex'), sh: bashScalar('PII_PHONE_REGEX') },
      { label: 'camera filename regex', ps: psScalar('PiiCameraFileRegex'), sh: bashScalar('PII_CAMERA_FILE_REGEX') },
      { label: 'PII pattern source allowlist', ps: psArray('PiiPatternSourceAllowList'), sh: bashArray('PII_PATTERN_SOURCE_ALLOW_LIST') },
    ],
  },
  {
    name: 'rust-no-secret-logs',
    ps1: 'tests/architecture/rust-no-secret-logs.ps1',
    sh: 'tests/architecture/rust-no-secret-logs.sh',
    checks: [{ label: 'logging regexes', ps: psPatternRegexes, sh: bashCaseRegexes }],
  },
  {
    name: 'rust-crypto-primitive-boundary',
    ps1: 'tests/architecture/rust-crypto-primitive-boundary.ps1',
    sh: 'tests/architecture/rust-crypto-primitive-boundary.sh',
    checks: [
      { label: 'crate roots', ps: psArray('CrateRoots'), sh: bashArray('CRATE_ROOTS') },
      { label: 'allowlist keys', ps: psHashtableKeys('AllowedFiles'), sh: bashAssocKeys('ALLOWED_FILES') },
      { label: 'pattern names', ps: psPatternNames, sh: bashArray('PATTERN_NAMES') },
      { label: 'pattern regexes', ps: psPatternRegexes, sh: bashPatternRegexes },
    ],
  },
  {
    name: 'web-no-direct-console',
    ps1: 'tests/architecture/web-no-direct-console.ps1',
    sh: 'tests/architecture/web-no-direct-console.sh',
    checks: [
      { label: 'console methods', ps: psArray('ConsoleMethods'), sh: bashArray('CONSOLE_METHODS') },
      { label: 'allowed patterns', ps: psArray('AllowedPatterns'), sh: bashArray('ALLOWED_PATTERNS') },
      { label: 'high-risk target entries', ps: psHighRiskTargets, sh: bashArray('HIGH_RISK_TARGETS') },
    ],
  },
  {
    name: 'android-no-direct-log',
    ps1: 'tests/architecture/android-no-direct-log.ps1',
    sh: 'tests/architecture/android-no-direct-log.sh',
    checks: [
      { label: 'pattern names', ps: psPatternNames, sh: bashArray('PATTERN_NAMES') },
      { label: 'pattern regexes', ps: psPatternRegexes, sh: bashPatternRegexes },
    ],
  },
];

describe.each(guardPairs)('$name architecture guard parity', ({ ps1, sh, checks }) => {
  const ps1Source = readRepoFile(ps1);
  const shSource = readRepoFile(sh);

  it.each(checks)('$label is symmetric', ({ ps, sh: extractSh }) => {
    const psValues = ps(ps1Source);
    const shValues = extractSh(shSource);
    expect(symmetricDifference(psValues, shValues)).toEqual([]);
  });
});
