import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const text = Type.String({ minLength: 1 });
const number = Type.Number();
const positive = Type.Integer({ minimum: 1, maximum: 4294967295 });
const pointer = Type.Object(
  {
    button: Type.Optional(
      Type.Union([
        Type.Literal("left"),
        Type.Literal("right"),
        Type.Literal("middle"),
      ]),
    ),
    count: Type.Optional(positive),
    modifiers: Type.Optional(Type.Array(text)),
    takeover: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const query = Type.Object(
  {
    role: Type.Optional(text),
    title: Type.Optional(text),
    value: Type.Optional(text),
    limit: Type.Optional(positive),
  },
  { additionalProperties: false },
);
const snapshot = Type.Object(
  {
    maxDepth: Type.Optional(positive),
    maxNodes: Type.Optional(positive),
    all: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
function method(
  read: boolean,
  signature: string,
  items: TSchema[] = [],
  required = items.length,
) {
  const tuples = Array.from({ length: items.length - required + 1 }, (_, i) =>
    Type.Tuple(items.slice(0, required + i)),
  );
  return {
    read,
    signature,
    args: tuples.length === 1 ? tuples[0]! : Type.Union(tuples),
  };
}

// One contract for tool documentation and host validation. Keep positional
// arguments on the wire; validate their tuples here before any native calls.
export const desktopMethods = {
  listDisplays: method(true, "listDisplays()"),
  listWindows: method(true, "listWindows()"),
  capture: method(true, "capture(target?)", [text], 0),
  axSnapshot: method(
    true,
    "axSnapshot(target, snapshotOptions?)",
    [text, snapshot],
    1,
  ),
  axQuery: method(true, "axQuery(target, {role?, title?, value?, limit?})", [
    text,
    query,
  ]),
  axElementAt: method(true, "axElementAt(target, globalX, globalY)", [
    text,
    number,
    number,
  ]),
  axFocused: method(true, "axFocused()"),
  axNode: method(true, "axNode(ref)", [text]),
  axAttributes: method(true, "axAttributes(ref)", [text]),
  axChildren: method(true, "axChildren(ref)", [text]),
  axParent: method(true, "axParent(ref)", [text]),
  click: method(
    false,
    "click(target, x, y, pointerOptions?)",
    [text, number, number, pointer],
    3,
  ),
  moveMouse: method(
    false,
    "moveMouse(target, x, y, pointerOptions?)",
    [text, number, number, pointer],
    3,
  ),
  scroll: method(
    false,
    "scroll(target, x, y, dx, dy, pointerOptions?)",
    [text, number, number, number, number, pointer],
    5,
  ),
  typeText: method(
    false,
    "typeText(target, text, pointerOptions?)",
    [text, Type.String({ maxLength: 10000 }), pointer],
    2,
  ),
  keyChord: method(
    false,
    "keyChord(target, keys: string[], pointerOptions?)",
    [text, Type.Array(text, { minItems: 1 }), pointer],
    2,
  ),
  raiseWindow: method(false, "raiseWindow(windowId)", [text]),
  axPerform: method(false, "axPerform(ref, action)", [text, text]),
  axSetValue: method(false, "axSetValue(ref, value)", [text, Type.String()]),
  axFocus: method(false, "axFocus(ref)", [text]),
  axClick: method(false, "axClick(ref, pointerOptions?)", [text, pointer], 1),
} as const;

export const computerParameters = Type.Object(
  {
    capabilities: Type.Optional(
      Type.Boolean({
        description:
          "检查权限。可与 operations 同时使用：先返回权限信息，再按序执行全部操作。",
      }),
    ),
    resume: Type.Optional(
      Type.Boolean({
        description: "恢复人工暂停，必须单独调用；恢复后重新读取界面。",
      }),
    ),
    operations: Type.Optional(
      Type.Array(
        Type.Object(
          {
            method: Type.Union(
              Object.keys(desktopMethods).map((name) => Type.Literal(name)),
            ),
            args: Type.Optional(
              Type.Array(Type.Any(), {
                description:
                  "按方法签名传位置参数。查询/选项必须是对象，快捷键是字符串数组；不转换错误类型。",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 32 },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ComputerRequest = Static<typeof computerParameters>;
export type DesktopOperation = NonNullable<
  ComputerRequest["operations"]
>[number];

export const computerSignatures =
  Object.values(desktopMethods)
    .map((m) => m.signature)
    .join(" / ") +
  '。pointerOptions={button?:"left"|"right"|"middle",count?:正整数,modifiers?:string[],takeover?:boolean}；snapshotOptions={maxDepth?:正整数,maxNodes?:正整数,all?:boolean}。axQuery 的第二个参数必须是对象，例如 {title:"保存",limit:10}；省略筛选条件使用 {}。';

export function validateDesktopOperations(
  operations: unknown,
): asserts operations is DesktopOperation[] {
  if (
    !Array.isArray(operations) ||
    !operations.length ||
    operations.length > 32
  )
    throw new Error("每批需要 1–32 个桌面操作");
  for (const [index, op] of operations.entries()) {
    if (
      !op ||
      typeof op !== "object" ||
      !Object.hasOwn(desktopMethods, op.method)
    )
      throw new Error(
        `第 ${index + 1} 个桌面操作的方法不支持；请使用已列出的方法名`,
      );
    const spec = desktopMethods[op.method as keyof typeof desktopMethods];
    if (
      Object.keys(op).some((key) => !["method", "args"].includes(key)) ||
      !Value.Check(spec.args, op.args === undefined ? [] : op.args)
    )
      throw new Error(
        `第 ${index + 1} 个桌面操作参数无效：${spec.signature}。查询和选项使用对象，坐标使用有限数字，快捷键使用字符串数组；整批尚未执行。`,
      );
  }
}

export function validateComputerRequest(
  value: unknown,
): asserts value is ComputerRequest {
  if (!Value.Check(computerParameters, value))
    throw new Error(
      "桌面请求参数无效：capabilities/resume 使用布尔值；operations 为 1–32 个 {method,args}，args 为数组",
    );
  const args = value as ComputerRequest;
  if (args.operations !== undefined) validateDesktopOperations(args.operations);
  if (args.resume && (args.capabilities || args.operations))
    throw new Error("resume:true 必须单独调用；恢复后重新观察界面，再执行操作");
  if (!args.resume && !args.capabilities && !args.operations)
    throw new Error("请指定 capabilities:true、resume:true 或 operations");
}
