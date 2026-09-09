/**
 * @fileoverview Tests for the IdGenerator utility.
 * @module tests/utils/security/idGenerator.test
 */
import { describe, expect, it } from 'vitest';

import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import {
  generateRequestContextId,
  generateUUID,
  IdGenerator,
} from '../../../../src/utils/security/idGenerator.js';

describe('IdGenerator and UUID', () => {
  describe('generateUUID', () => {
    it('should generate a valid v4 UUID', () => {
      const uuid = generateUUID();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuid).toMatch(uuidRegex);
    });
  });

  describe('generateRequestContextId', () => {
    it('should generate a valid 10-character uppercase alphanumeric ID with a hyphen', () => {
      const id = generateRequestContextId();
      const idRegex = /^[A-Z0-9]{5}-[A-Z0-9]{5}$/;
      expect(id).toMatch(idRegex);
      expect(id).toHaveLength(11);
    });
  });

  describe('IdGenerator', () => {
    const entityPrefixes = {
      user: 'USR',
      project: 'PROJ',
    };
    const idGenerator = new IdGenerator(entityPrefixes);

    it('should generate a random string of default length', () => {
      const randomStr = idGenerator.generateRandomString();
      expect(randomStr).toHaveLength(6);
    });

    it('should generate a random string of specified length and charset', () => {
      const randomStr = idGenerator.generateRandomString(10, 'abc');
      expect(randomStr).toHaveLength(10);
      expect(randomStr).toMatch(/^[a-c]{10}$/);
    });

    it('stays within the charset across refills when rejection sampling discards bytes', () => {
      // 256 % 3 !== 0, so byte 255 is rejected and the draw loop has to refill.
      const randomStr = idGenerator.generateRandomString(5000, 'abc');
      expect(randomStr).toHaveLength(5000);
      expect(randomStr).toMatch(/^[a-c]+$/);
    });

    it('should generate a simple ID without a prefix', () => {
      const id = idGenerator.generate();
      expect(id).toHaveLength(6);
    });

    it('should generate an ID with a custom prefix', () => {
      const id = idGenerator.generate('CUSTOM');
      expect(id).toMatch(/^CUSTOM_/);
      expect(id).toHaveLength(13); // CUSTOM_ + 6 chars
    });

    it('should generate an ID for a registered entity', () => {
      const userId = idGenerator.generateForEntity('user');
      expect(userId).toMatch(/^USR_/);
    });

    it('should throw an error when generating for an unknown entity', () => {
      expect(() => idGenerator.generateForEntity('unknown')).toThrow(McpError);
      try {
        idGenerator.generateForEntity('unknown');
      } catch (error) {
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
      }
    });

    it('should validate a correct ID', () => {
      const userId = idGenerator.generateForEntity('user');
      expect(idGenerator.isValid(userId, 'user')).toBe(true);
    });

    it('should invalidate an incorrect ID', () => {
      expect(idGenerator.isValid('USR_123', 'user')).toBe(false); // Wrong length
      expect(idGenerator.isValid('PROJ_ABCDEF', 'user')).toBe(false); // Wrong prefix
    });

    it('should strip the prefix from an ID', () => {
      const userId = 'USR_ABC123';
      expect(idGenerator.stripPrefix(userId)).toBe('ABC123');
    });

    it('should get the entity type from an ID', () => {
      const projId = 'PROJ_XYZ789';
      expect(idGenerator.getEntityType(projId)).toBe('project');
    });

    it('should throw an error for an unknown prefix when getting entity type', () => {
      expect(() => idGenerator.getEntityType('UNK_123')).toThrow(McpError);
    });

    it('should normalize an ID', () => {
      const lowerCaseId = 'usr_abc123';
      expect(idGenerator.normalize(lowerCaseId)).toBe('USR_ABC123');
    });

    it('should handle custom separators', () => {
      const customGenerator = new IdGenerator({ test: 'TEST' });
      const options = { separator: '-' };
      const id = customGenerator.generate('TEST', options);
      expect(id).toContain('-');
      expect(customGenerator.stripPrefix(id, '-')).not.toContain('-');
      expect(customGenerator.getEntityType(id, '-')).toBe('test');
    });
  });
});
