export const examples = [
  {
    id: "clamp-range",
    title: "Clamp range regression",
    subtitle: "Wrong upper-bound variable",
    bugReport:
      "clamp(value, min, max) returns max for in-range values above min. It should only return max when value is greater than max.",
    source: `function clamp(value, min, max) {
  if (value < min) return min;
  if (value > min) return max;
  return value;
}`,
    tests: [
      { name: "below min is raised", args: [-5, 0, 10], expect: 0 },
      { name: "above max is lowered", args: [12, 0, 10], expect: 10 },
      { name: "in range is preserved", args: [6, 0, 10], expect: 6 },
      { name: "lower boundary is stable", args: [0, 0, 10], expect: 0 },
      { name: "upper boundary is stable", args: [10, 0, 10], expect: 10 }
    ],
    precondition: "args[1] <= args[2]",
    mayChange: "args[0] > args[1] && args[0] < args[2]",
    postcondition: "result === Math.min(Math.max(args[0], args[1]), args[2])"
  },
  {
    id: "slugify-whitespace",
    title: "Slug whitespace bug",
    subtitle: "Only first space is replaced",
    bugReport:
      "slugify should collapse every run of whitespace into one dash. The current implementation only replaces the first single space.",
    source: `function slugify(title) {
  const cleaned = title.trim().toLowerCase();
  return cleaned.replace(" ", "-");
}`,
    tests: [
      { name: "single word", args: ["Hello"], expect: "hello" },
      { name: "one space", args: ["Hello World"], expect: "hello-world" },
      { name: "multiple spaces", args: ["Hello   World"], expect: "hello-world" },
      { name: "leading and trailing whitespace", args: ["  API Client  "], expect: "api-client" }
    ],
    precondition: "typeof args[0] === 'string'",
    mayChange: "/\\s/.test(args[0].trim())",
    postcondition: "result === args[0].trim().toLowerCase().replace(/\\s+/g, '-')"
  },
  {
    id: "take-limit",
    title: "List limit off by one",
    subtitle: "Drops one valid item",
    bugReport:
      "take(items, limit) should return up to limit items. Positive limits currently return one fewer item than requested.",
    source: `function take(items, limit) {
  if (limit <= 0) return [];
  return items.slice(0, limit - 1);
}`,
    tests: [
      { name: "zero limit", args: [[1, 2, 3], 0], expect: [] },
      { name: "negative limit", args: [[1, 2, 3], -1], expect: [] },
      { name: "two item limit", args: [[1, 2, 3], 2], expect: [1, 2] },
      { name: "limit past length", args: [[1, 2, 3], 9], expect: [1, 2, 3] }
    ],
    precondition: "Array.isArray(args[0]) && Number.isInteger(args[1])",
    mayChange: "args[1] > 0",
    postcondition:
      "Array.isArray(result) && result.length === Math.min(Math.max(args[1], 0), args[0].length) && result.every((value, index) => value === args[0][index])"
  }
];

export function createInputFromExample(example) {
  return {
    source: example.source,
    testsText: JSON.stringify(example.tests, null, 2),
    bugReport: example.bugReport,
    preconditionText: example.precondition,
    mayChangeText: example.mayChange,
    postconditionText: example.postcondition
  };
}
