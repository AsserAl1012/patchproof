import ast
import json
import sys


def main():
    request = json.loads(sys.stdin.read() or "{}")
    source = request.get("source") or ""
    function_name = request.get("functionName") or ""
    tree = ast.parse(source)
    tests = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assert):
            continue
        extracted = assertion_to_test(node.test, function_name, len(tests) + 1)
        if extracted:
            tests.append(extracted)
    sys.stdout.write(json.dumps({"tests": tests}))


def assertion_to_test(node, function_name, index):
    if not isinstance(node, ast.Compare) or len(node.ops) != 1 or not isinstance(node.ops[0], ast.Eq):
        return None
    if len(node.comparators) != 1:
        return None
    call = node.left
    if not isinstance(call, ast.Call) or call_name(call.func) != function_name:
        return None
    try:
        return {
            "name": f"pytest {function_name} case {index}",
            "args": [literal(arg) for arg in call.args],
            "expect": literal(node.comparators[0]),
        }
    except ValueError:
        return None


def call_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def literal(node):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        value = literal(node.operand)
        if isinstance(value, (int, float)):
            return -value
    if isinstance(node, ast.List) or isinstance(node, ast.Tuple):
        return [literal(item) for item in node.elts]
    if isinstance(node, ast.Dict):
        return {literal(key): literal(value) for key, value in zip(node.keys, node.values)}
    raise ValueError(f"unsupported literal: {type(node).__name__}")


if __name__ == "__main__":
    main()
