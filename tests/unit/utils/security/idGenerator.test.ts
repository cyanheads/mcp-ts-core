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

    it('draws from a 1-character charset and from the 256-character ceiling', () => {
      expect(idGenerator.generateRandomString(8, 'x')).toBe('xxxxxxxx');
      const full = String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i));
      expect(idGenerator.generateRandomString(8, full)).toHaveLength(8);
    });

    it.each([
      ['an empty charset', ''],
      ['a charset longer than 256 characters', 'x'.repeat(257)],
    ])('rejects %s instead of sampling forever', (_label, charset) => {
      // The sampler cannot terminate on either bound, so this must throw synchronously.
      expect(() => idGenerator.generateRandomString(8, charset)).toThrow(McpError);
      expect(() => idGenerator.generateRandomString(8, charset)).toThrow(
        expect.objectContaining({ code: JsonRpcErrorCode.ValidationError }),
      );
      expect(() => idGenerator.generate('PFX', { charset })).toThrow(
        expect.objectContaining({ code: JsonRpcErrorCode.ValidationError }),
      );
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

    describe('failure reasons', () => {
      /** The McpError `run` throws. */
      function failureOf(run: () => unknown): McpError {
        try {
          run();
        } catch (error) {
          expect(error).toBeInstanceOf(McpError);
          return error as McpError;
        }
        throw new Error('expected the call to throw');
      }

      it('rejects an out-of-range charset as invalid_charset', () => {
        const error = failureOf(() => idGenerator.generateRandomString(8, ''));

        expect(error.data).toEqual({ charsetLength: 0, max: 256, reason: 'invalid_charset' });
      });

      it('rejects an unregistered entity type as unknown_entity_type', () => {
        const error = failureOf(() => idGenerator.generateForEntity('unknown'));

        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data).toEqual({ entityType: 'unknown', reason: 'unknown_entity_type' });
      });

      it.each([
        ['no separator', 'NOSEPARATOR'],
        ['an empty prefix', '_ABC123'],
      ])('rejects an ID with %s as invalid_id_format, naming the expected shape', (_label, id) => {
        const error = failureOf(() => idGenerator.getEntityType(id));

        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data).toMatchObject({
          id,
          reason: 'invalid_id_format',
          recovery: { hint: expect.stringContaining('PREFIX_RANDOMPART') },
        });
      });

      it('rejects an unknown ID prefix as unknown_entity_type, naming the registered prefixes', () => {
        const error = failureOf(() => idGenerator.getEntityType('UNK_123'));

        expect(error.data).toEqual({
          prefix: 'UNK',
          reason: 'unknown_entity_type',
          recovery: { hint: 'Use an ID whose prefix is one of: USR, PROJ.' },
        });
      });

      it('carries the same reason through normalize', () => {
        expect(failureOf(() => idGenerator.normalize('UNK_123')).data?.reason).toBe(
          'unknown_entity_type',
        );
      });
    });
  });
});
