import prompts from "npm:prompts";
import chalk from "https://deno.land/x/chalk_deno@v4.1.1-deno/source/index.js";
import { format } from "https://deno.land/std@0.224.0/datetime/format.ts";

class Runner {
  static async run(command: string, args: string[]) {
    const cmd = await new Deno.Command(command, { args }).output();
    const output = new TextDecoder().decode(cmd.stdout);
    const stderr = new TextDecoder().decode(cmd.stderr);
    const code = cmd.code;
    if (code !== 0) {
      throw new Error(
        `Failed to run command [${[command, ...args].join(" ")}]\n${stderr}`
      );
    }
    return { output, code, stderr };
  }
}

class Helm {
  static async getReleases(namespace: string): Promise<string[]> {
    const { output } = await this.run(["list", "-q", "-n", namespace]);
    const releases = output.trim().split("\n");
    return releases;
  }

  static async run(
    args: string[]
  ): Promise<{ output: string; code: number; stderr: string }> {
    return await Runner.run("helm", [...args]);
  }

  static async getReleaseStatus(
    release: string,
    namespace: string
  ): Promise<string> {
    const { output } = await this.run([
      "status",
      release,
      "-n",
      namespace,
      "--output",
      "json",
    ]);
    const json = JSON.parse(output);
    return json;
  }

  static async getReleaseHistory(release: string, namespace: string) {
    const { output } = await this.run([
      "history",
      release,
      "-n",
      namespace,
      "--output",
      "table",
    ]);

    return output;
  }
}

class Kubectl {
  static async getPodsInfo(app: string, namespace: string) {
    const { output } = await this.run([
      "get",
      "pods",
      "-n",
      namespace,
      "-l",
      `app=${app}`,
      "-o",
      "json",
    ]);
    const json = JSON.parse(output).items;
    const pods = json.filter((p: any) => p.kind === "Pod");
    const podsInfo = [];
    for (const pod of pods) {
      const info = {
        Name: pod.metadata.name,
        Status: pod.status.phase,
        Started: format(new Date(pod.status.startTime), "yyyy-MM-dd HH:mm:ss"),
        Image: pod.spec.containers[0].image.split(":")[1],
      };
      podsInfo.push(info);
    }
    return podsInfo;
  }

  static async getConfigContexts(): Promise<string[]> {
    const { output, code, stderr } = await this.run([
      "config",
      "get-contexts",
      "-o",
      "name",
    ]);
    const contexts = output.trim().split("\n");
    return contexts;
  }

  static async getNamespaces(): Promise<string[]> {
    const { output } = await this.run(["get", "namespaces", "-o", "name"]);
    return output
      .trim()
      .split("\n")
      .filter((n) => n.includes("dev") || n.includes("test"))
      .map((n) => n.split("/")[1]);
  }

  static async run(
    args: string[]
  ): Promise<{ output: string; code: number; stderr: string }> {
    return await Runner.run("kubectl", [...args]);
  }

  static async useConfigContext(
    context: string
  ): Promise<{ output: string; code: number; stderr: string }> {
    const contexts = await this.getConfigContexts();
    if (!contexts.includes(context)) {
      throw new Error(`Context [${context}] not found`);
    }
    return await Runner.run("kubectl", ["config", "use-context", context]);
  }

  // get current context
  static async getCurrentContext(): Promise<string> {
    const { output } = await this.run(["config", "current-context"]);
    return output.trim();
  }
}

async function getServiceStatusPrompt() {
  const namespaces = await Kubectl.getNamespaces();
  const response = await prompts([
    {
      type: "select",
      name: "namespace",
      message: "Select the namespace",
      choices: namespaces.map((n) => ({ title: n, value: n })),
    },
  ]);
  if (!response.namespace) return;

  const releases = await Helm.getReleases(response.namespace);
  const releaseResponse = await prompts([
    {
      type: "multiselect",
      name: "release",
      message: "Select the release",
      choices: releases.map((r) => ({ title: r, value: r })),
    },
  ]);
  if (!releaseResponse.release) return;

  const statuses = [];
  for (const release of releaseResponse.release) {
    const status = await Helm.getReleaseStatus(release, response.namespace);
    statuses.push({
      Name: status.name,
      Image: status.config.image.tag,
      Status: status.info.status,
      "Last Deployed": format(
        new Date(status.info.last_deployed),
        "yyyy-MM-dd HH:mm:ss"
      ),
    });
  }
  console.table(statuses);
  if (statuses.length === 1) {
    const podsInfo = await Kubectl.getPodsInfo(
      statuses[0].Name,
      response.namespace
    );
    console.table(podsInfo);

    const history = await Helm.getReleaseHistory(
      statuses[0].Name,
      response.namespace
    );
    console.log("\n", history);
  }
}

async function switchContextPrompt() {
  const contexts = await Kubectl.getConfigContexts();
  const currentContext = await Kubectl.getCurrentContext();
  const choices = [
    {
      title: "dev",
      value: contexts.find((c) => c.endsWith("pigeon")),
      description: contexts.find((c) => c.endsWith("pigeon")),
    },
    {
      title: "test",
      value: contexts.find((c) => c.endsWith("westeu-001-aks")),
      description: contexts.find((c) => c.endsWith("westeu-001-aks")),
    },
  ];

  const response = await prompts([
    {
      type: "select",
      name: "context",
      message: "Environment to switch to:",
      choices,
      initial: choices.findIndex((c) => c.value === currentContext),
    },
  ]);

  if (!response.context) return;
  const { output } = await Kubectl.useConfigContext(response.context);
  console.log(output);
}
async function entryPoint() {
  const choices = [
    {
      title: "Service Status",
      value: getServiceStatusPrompt,
    },
    {
      title: "Switch context",
      value: switchContextPrompt,
    },
    {
      title: "\nExit",
      value: async () => {
        console.log("Goodbye!");
        Deno.exit(0);
      },
    },
  ];
  while (true) {
    const currentContext = await Kubectl.getCurrentContext();
    console.log("\nCurrent context:", chalk.bgBlue(currentContext));

    const response = await prompts([
      {
        type: "select",
        name: "action",
        message: "What do you want to do?",
        choices,
      },
    ]);
    if (!response.action) Deno.exit(0);
    await response.action();
  }
}

// Run the script
await entryPoint();
