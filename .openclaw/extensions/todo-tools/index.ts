const PYTHON_BACKEND_BASE_URL = process.env.PYTHON_BACKEND_BASE_URL || "http://127.0.0.1:8787";

async function callBackendTool(path, body) {
  const response = await fetch(`${PYTHON_BACKEND_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Backend request failed: ${response.status}`);
  }
  return response.json();
}

export default function register(api) {
  api.registerTool({
    name: "create_todo",
    description:
      "Create a todo/reminder when user mentions a task with a specific time. Extract the time expression and task content from the user message. Always call this when user says something like '明天下午3点开会' or '晚上8点提醒我吃饭'.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            'The full text containing time expression and task content, e.g., "周四下午1点去单位开会"',
        },
      },
      required: ["text"],
    },
    async execute(_id, params) {
      try {
        const result = await callBackendTool("/tools/todo/create", {
          text: params.text,
          source: "openclaw_tool",
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating todo: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  api.registerTool({
    name: "list_todos",
    description: "List all pending todos/reminders. Shows tasks that are waiting to be completed.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_id) {
      try {
        const result = await callBackendTool("/tools/todo/list", {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing todos: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}