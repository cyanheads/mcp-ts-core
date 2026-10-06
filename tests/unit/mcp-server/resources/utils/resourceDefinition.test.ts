/**
 * @fileoverview Tests for resource definition interface and builder.
 * @module tests/mcp-server/resources/utils/resourceDefinition.test
 */

import { describe, expect, it } from 'vitest';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';

describe('resource() builder', () => {
  it('takes the URI template from its first argument and carries every option through', () => {
    const def = resource('docs://{docId}', {
      description: 'Get document',
      name: 'custom_resource_name',
      title: 'Document Lookup',
      mimeType: 'text/markdown',
      examples: [
        { name: 'First doc', uri: 'docs://1' },
        { name: 'Second doc', uri: 'docs://2' },
      ],
      annotations: {
        audience: ['user'],
        priority: 0.8,
        lastModified: '2026-03-14T00:00:00Z',
      },
      handler: () => ({ content: '# Hello' }),
    });

    expect(def).toMatchObject({
      uriTemplate: 'docs://{docId}',
      description: 'Get document',
      name: 'custom_resource_name',
      title: 'Document Lookup',
      mimeType: 'text/markdown',
      examples: [
        { name: 'First doc', uri: 'docs://1' },
        { name: 'Second doc', uri: 'docs://2' },
      ],
      annotations: {
        audience: ['user'],
        priority: 0.8,
        lastModified: '2026-03-14T00:00:00Z',
      },
    });
  });
});
