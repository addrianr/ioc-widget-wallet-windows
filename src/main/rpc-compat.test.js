const fs = require('fs');
const rpcCompat = require('./rpc-compat');
const { readConf, dataDir } = rpcCompat._private;

// Mock the entire fs module
jest.mock('fs');
// We also need to mock dataDir, because it uses fs.existsSync internally
jest.mock('./rpc-compat', () => {
  const originalModule = jest.requireActual('./rpc-compat');
  // Mock only the _private.dataDir function
  return {
    ...originalModule,
    _private: {
      ...originalModule._private,
      dataDir: jest.fn(),
    },
  };
});


describe('rpc-compat', () => {
  describe('readConf', () => {

    beforeEach(() => {
      // Clear all instances and calls to constructor and all methods:
      fs.existsSync.mockClear();
      fs.readFileSync.mockClear();
      dataDir.mockClear();
    });

    it('should return default config if conf file does not exist', () => {
      // Arrange
      dataDir.mockReturnValue('/fake/dir');
      fs.existsSync.mockReturnValue(false);

      // Act
      const result = readConf();

      // Assert
      expect(result).toEqual({ user: '', pass: '', port: 33765, host: '127.0.0.1' });
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it('should parse user, pass, port, and host from conf file', () => {
      // Arrange
      const confContent = `
# some comment
rpcuser=myuser
rpcpassword=mypassword
rpcport=8332
rpcbind=0.0.0.0
      `;
      dataDir.mockReturnValue('/fake/dir');
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(confContent);

      // Act
      const result = readConf();

      // Assert
      expect(result).toEqual({
        user: 'myuser',
        pass: 'mypassword',
        port: 8332,
        host: '0.0.0.0',
      });
    });

    it('should handle empty or commented lines', () => {
        // Arrange
        const confContent = `
  # rpcuser=olduser
rpcuser=newuser

rpcpassword=newpassword
      `;
        dataDir.mockReturnValue('/fake/dir');
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(confContent);
  
        // Act
        const result = readConf();
  
        // Assert
        expect(result.user).toBe('newuser');
        expect(result.pass).toBe('newpassword');
    });

    it('should ignore invalid lines', () => {
      // Arrange
      const confContent = 'just-some-invalid-line';
      dataDir.mockReturnValue('/fake/dir');
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(confContent);

      // Act
      const result = readConf();

      // Assert
      expect(result).toEqual({ user: '', pass: '', port: 33765, host: '127.0.0.1' });
    });
  });
});
