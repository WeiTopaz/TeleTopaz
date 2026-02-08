export type GuardrailRule = {
  id: string;
  description?: string;
  contains?: string[];
  regex?: string[];
};

export type GuardrailPolicy = {
  version: number;
  maxPromptLength?: number;
  denyRules?: GuardrailRule[];
  allowRules?: GuardrailRule[];
};

export type GuardrailDecision = {
  allowed: boolean;
  ruleId?: string;
  source: "length" | "builtin" | "semantic" | "deny" | "allow" | "default";
  reason?: string;
};
