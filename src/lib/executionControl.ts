export type ExecutionControlTarget = "aster" | "web3" | null;

export function resolveExecutionControl(input: {
  asterConnected: boolean;
  web3Connected: boolean;
  asterKillSwitchActive: boolean;
  web3KillSwitchActive: boolean;
}): { target: ExecutionControlTarget; killSwitchActive: boolean } {
  if (input.asterConnected) {
    return { target: "aster", killSwitchActive: input.asterKillSwitchActive };
  }
  if (input.web3Connected) {
    return { target: "web3", killSwitchActive: input.web3KillSwitchActive };
  }
  return { target: null, killSwitchActive: false };
}
