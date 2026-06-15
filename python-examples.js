export const pythonExamples = [
  {
    id: "python-clamp-range",
    language: "python",
    title: "Python clamp regression",
    subtitle: "Wrong upper-bound variable",
    bugReport: "clamp returns max for in-range values above min; the upper guard should compare value to max.",
    source: `def clamp(value, min, max):
    if value < min:
        return min
    if value > min:
        return max
    return value`,
    tests: [
      { name: "below min", args: [-5, 0, 10], expect: 0 },
      { name: "above max", args: [12, 0, 10], expect: 10 },
      { name: "in range", args: [6, 0, 10], expect: 6 },
      { name: "upper boundary", args: [10, 0, 10], expect: 10 }
    ],
    precondition: "args[1] <= args[2]",
    mayChange: "args[0] > args[1] and args[0] < args[2]",
    postcondition: "result == min(max(args[0], args[1]), args[2])"
  }
];
