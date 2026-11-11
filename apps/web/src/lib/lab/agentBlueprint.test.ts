import { describe, it, expect } from 'vitest';
import {
  createDefaultBlueprint,
  validateBlueprint,
  exportBlueprintToJson,
  exportBlueprintToYaml,
  AgentBlueprint,
} from './agentBlueprint';

describe('agentBlueprint', () => {
  it('creates a valid default blueprint with full schema compliance', () => {
    const blueprint = createDefaultBlueprint('Test Systems Architect');
    expect(blueprint.name).toBe('Test Systems Architect');
    expect(blueprint.schemaVersion).toBe('1.0.0');
    expect(blueprint.methodology.framework).toBe('react');
    expect(blueprint.tools.prebuilt.length).toBeGreaterThan(0);
    expect(blueprint.modelRouting.performanceTier).toBe('max-reasoning');

    const validation = validateBlueprint(blueprint);
    expect(validation.valid).toBe(true);
    expect(validation.errors.length).toBe(0);
    expect(validation.blueprint?.name).toBe('Test Systems Architect');
  });

  it('rejects invalid blueprints with missing required fields', () => {
    const invalidObj = { name: '', role: '' };
    const validation = validateBlueprint(invalidObj);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('Agent Name is required.');
  });

  it('exports blueprint to JSON and YAML manifests accurately', () => {
    const blueprint = createDefaultBlueprint('Export Test Agent');
    const jsonStr = exportBlueprintToJson(blueprint);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.name).toBe('Export Test Agent');

    const yamlStr = exportBlueprintToYaml(blueprint);
    expect(yamlStr).toContain('schemaVersion: "1.0.0"');
    expect(yamlStr).toContain('name: "Export Test Agent"');
    expect(yamlStr).toContain('framework: "react"');
  });
});
