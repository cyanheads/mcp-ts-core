/**
 * @fileoverview Test suite for MCP OpenTelemetry attribute keys.
 * @module tests/utils/telemetry/attributes.test
 */

import { describe, expect, test } from 'vitest';
import * as attributes from '@/utils/telemetry/attributes.js';

describe('MCP OpenTelemetry Attribute Keys', () => {
  describe('Code execution attributes', () => {
    test('should export code function attribute', () => {
      expect(attributes.ATTR_CODE_FUNCTION_NAME).toBe('code.function.name');
    });

    test('should export code namespace attribute', () => {
      expect(attributes.ATTR_CODE_NAMESPACE).toBe('code.namespace');
    });
  });

  describe('MCP Tool Execution Attributes', () => {
    test('should export MCP tool name attribute', () => {
      expect(attributes.ATTR_MCP_TOOL_NAME).toBe('mcp.tool.name');
    });

    test('should export MCP tool input bytes attribute', () => {
      expect(attributes.ATTR_MCP_TOOL_INPUT_BYTES).toBe('mcp.tool.input_bytes');
    });

    test('should export MCP tool output bytes attribute', () => {
      expect(attributes.ATTR_MCP_TOOL_OUTPUT_BYTES).toBe('mcp.tool.output_bytes');
    });

    test('should export MCP tool duration attribute', () => {
      expect(attributes.ATTR_MCP_TOOL_DURATION_MS).toBe('mcp.tool.duration_ms');
    });

    test('should export MCP tool success attribute', () => {
      expect(attributes.ATTR_MCP_TOOL_SUCCESS).toBe('mcp.tool.success');
    });

    test('should export MCP tool error code attribute', () => {
      expect(attributes.ATTR_MCP_TOOL_ERROR_CODE).toBe('mcp.tool.error_code');
    });

    test('should export MCP tool error category attribute', () => {
      expect(attributes.ATTR_MCP_TOOL_ERROR_CATEGORY).toBe('mcp.tool.error_category');
    });

    test('should export MCP tool outcome attribute', () => {
      expect(attributes.ATTR_MCP_TOOL_OUTCOME).toBe('mcp.tool.outcome');
    });

    test('should export MCP tool partial success attribute', () => {
      expect(attributes.ATTR_MCP_TOOL_PARTIAL_SUCCESS).toBe('mcp.tool.partial_success');
    });

    test('should export MCP tool batch succeeded count attribute', () => {
      expect(attributes.ATTR_MCP_TOOL_BATCH_SUCCEEDED).toBe('mcp.tool.batch.succeeded_count');
    });

    test('should export MCP tool batch failed count attribute', () => {
      expect(attributes.ATTR_MCP_TOOL_BATCH_FAILED).toBe('mcp.tool.batch.failed_count');
    });
  });

  describe('MCP Resource Attributes', () => {
    test('should export MCP resource URI attribute', () => {
      expect(attributes.ATTR_MCP_RESOURCE_URI).toBe('mcp.resource.uri');
    });

    test('should export MCP resource MIME type attribute', () => {
      expect(attributes.ATTR_MCP_RESOURCE_MIME_TYPE).toBe('mcp.resource.mime_type');
    });

    test('should export MCP resource size attribute', () => {
      expect(attributes.ATTR_MCP_RESOURCE_SIZE_BYTES).toBe('mcp.resource.size_bytes');
    });
  });

  describe('MCP Request Context Attributes', () => {
    test('should export MCP tenant ID attribute', () => {
      expect(attributes.ATTR_MCP_TENANT_ID).toBe('mcp.tenant.id');
    });

    test('should export MCP client ID attribute', () => {
      expect(attributes.ATTR_MCP_CLIENT_ID).toBe('mcp.client.id');
    });
  });

  describe('MCP Error Classification Attributes', () => {
    test('should export the classified error code attribute', () => {
      expect(attributes.ATTR_MCP_ERROR_CLASSIFIED_CODE).toBe('mcp.error.classified_code');
    });

    test('should export the classified error category attribute', () => {
      expect(attributes.ATTR_MCP_ERROR_CATEGORY).toBe('mcp.error.category');
    });
  });

  describe('Naming conventions', () => {
    test('all MCP custom attributes should use mcp namespace prefix', () => {
      const mcpAttrs = Object.entries(attributes)
        .filter(([key]) => key.startsWith('ATTR_MCP_'))
        .map(([, value]) => value);

      mcpAttrs.forEach((attr) => {
        expect(attr).toMatch(/^mcp\./);
      });
    });

    test('should not have duplicate attribute values', () => {
      const allExports = Object.entries(attributes)
        .filter(([key]) => key.startsWith('ATTR_'))
        .map(([, value]) => value);

      const uniqueValues = new Set(allExports);
      expect(allExports.length).toBe(uniqueValues.size);
    });

    test('all attributes should use dot notation', () => {
      const allAttrs = Object.entries(attributes)
        .filter(([key]) => key.startsWith('ATTR_'))
        .map(([, value]) => value);

      allAttrs.forEach((attr) => {
        expect(attr).toMatch(/^[a-z]+[a-z_]*(\.[a-z][a-z_]*)+$/);
      });
    });
  });
});
