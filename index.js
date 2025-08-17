const http = require('http');
const https = require('https');
const url = require('url');

module.exports = (api) => {
  api.registerAccessory('Gate', GateAccessory);
};

let Service, Characteristic;

class GateAccessory {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    // Initialize Service and Characteristic from the API
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;

    this.name = config.name || 'Gate';
    this.httpPort = config.httpPort || 8080;
    this.deviceApiUrl = config.deviceApiUrl;

    // State mirrored from device
    this.currentDoorState = Characteristic.CurrentDoorState.CLOSED;
    this.targetDoorState = Characteristic.TargetDoorState.CLOSED;
    this.lockCurrentState = Characteristic.LockCurrentState.SECURED;
    this.lockTargetState = Characteristic.LockTargetState.SECURED;

    this.Service = Service;
    this.Characteristic = Characteristic;

    // Create services
    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'ap0')
      .setCharacteristic(Characteristic.Model, 'Gate Controller')
      .setCharacteristic(Characteristic.SerialNumber, '001');

    this.lockService = new Service.LockManagement(this.name + ' Lock');
    this.lockService
      .getCharacteristic(Characteristic.LockCurrentState)
      .onGet(this.getLockCurrentState.bind(this));

    this.lockService
      .getCharacteristic(Characteristic.LockTargetState)
      .onGet(this.getLockTargetState.bind(this))
      .onSet(this.setLockTargetState.bind(this));

    this.doorService = new Service.GarageDoorOpener(this.name);
    this.doorService
      .getCharacteristic(Characteristic.CurrentDoorState)
      .onGet(this.getCurrentDoorState.bind(this));

    this.doorService
      .getCharacteristic(Characteristic.TargetDoorState)
      .onGet(this.getTargetDoorState.bind(this))
      .onSet(this.setTargetDoorState.bind(this));

    this.doorService
      .getCharacteristic(Characteristic.ObstructionDetected)
      .onGet(() => false);

    this.doorbellService = new Service.Doorbell(this.name + ' Bell');
    this.doorbellService
      .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
      .setProps({
        validValues: [Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS]
      });

    // Register with Homebridge's web server if available
    this.setupWebHandler();

    this.log.info('Gate accessory initialized');
  }

  getServices() {
    return [this.informationService, this.lockService, this.doorService, this.doorbellService];
  }

  // Setup web handler using standalone server
  setupWebHandler() {
    // Always use standalone server for simplicity
    this.startHttpServer();
  }

  setupExpressRoute() {
    try {
      // Check if we can access Homebridge's internal server
      if (this.api && this.api.user && this.api.user.configPath) {
        // Try to get the Homebridge server instance
        const HomebridgeAPI = require('homebridge/lib/api').default || require('homebridge/lib/api');
        // This approach likely won't work, fall back to standalone
        throw new Error('Express integration not available');
      }
      
      const app = global.homebridgeExpress;
      app.post(`/api/accessories/${this.name.toLowerCase().replace(/\s+/g, '-')}/status`, (req, res) => {
        try {
          this.updateFromDevice(req.body);
          res.json({ success: true });
          this.log.debug('Status update received via Homebridge API');
        } catch (error) {
          this.log.error('Error processing status update:', error);
          res.status(400).json({ error: 'Invalid data' });
        }
      });
      
      this.log.info(`Status endpoint: /api/accessories/${this.name.toLowerCase().replace(/\s+/g, '-')}/status`);
    } catch (error) {
      this.log.warn('Could not setup express route, falling back to standalone server:', error);
      this.startHttpServer();
    }
  }

  // Fallback HTTP Server for receiving device status updates
  startHttpServer() {
    this.server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/status') {
        let body = '';
        
        req.on('data', chunk => {
          body += chunk.toString();
        });
        
        req.on('end', () => {
          try {
            const status = JSON.parse(body);
            this.updateFromDevice(status);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (error) {
            this.log.error('Error parsing status update:', error);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    this.server.listen(this.httpPort, (err) => {
      if (err) {
        this.log.error('Failed to start HTTP server:', err);
      } else {
        this.log.info(`HTTP server listening on port ${this.httpPort}`);
        this.log.info(`Device should POST status updates to: http://localhost:${this.httpPort}/status`);
      }
    });
  }

  // Update HomeKit state based on device status
  updateFromDevice(status) {
    this.log.info('Received status update:', JSON.stringify(status));

    // Update door state
    if (status.doorState !== undefined) {
      const newDoorState = this.mapDoorState(status.doorState);
      if (newDoorState !== this.currentDoorState) {
        this.currentDoorState = newDoorState;
        this.doorService.updateCharacteristic(Characteristic.CurrentDoorState, this.currentDoorState);
        
        // Update target state to match current state for stable states
        if (newDoorState === Characteristic.CurrentDoorState.OPEN || 
            newDoorState === Characteristic.CurrentDoorState.CLOSED) {
          const targetState = newDoorState === Characteristic.CurrentDoorState.OPEN ? 
            Characteristic.TargetDoorState.OPEN : Characteristic.TargetDoorState.CLOSED;
          
          if (targetState !== this.targetDoorState) {
            this.targetDoorState = targetState;
            this.doorService.updateCharacteristic(Characteristic.TargetDoorState, this.targetDoorState);
          }
        }
        
        this.log.info('Door state updated to:', this.getDoorStateName(this.currentDoorState));
      }
    }

    if (status.targetDoorState !== undefined) {
      const newTargetDoorState = this.mapDoorState(status.targetDoorState);
      if (newTargetDoorState !== this.targetDoorState) {
        this.targetDoorState = newTargetDoorState;
        this.doorService.updateCharacteristic(Characteristic.TargetDoorState, this.targetDoorState);
      }
    }

    // Update lock state
    if (status.lockState !== undefined) {
      const newLockState = status.lockState === 'locked' ? 
        Characteristic.LockCurrentState.SECURED : 
        Characteristic.LockCurrentState.UNSECURED;
      
      if (newLockState !== this.lockCurrentState) {
        this.lockCurrentState = newLockState;
        this.lockTargetState = newLockState;
        this.lockService.updateCharacteristic(Characteristic.LockCurrentState, this.lockCurrentState);
        this.lockService.updateCharacteristic(Characteristic.LockTargetState, this.lockTargetState);
        this.log.info('Lock state updated to:', status.lockState);
      }
    }

    // Handle doorbell event
    if (status.doorbell === true) {
      this.triggerDoorbell();
    }
  }

  // Map device door states to HomeKit characteristics
  mapDoorState(deviceState) {
    switch (deviceState) {
      case 'open': return Characteristic.CurrentDoorState.OPEN;
      case 'closed': return Characteristic.CurrentDoorState.CLOSED;
      case 'opening': return Characteristic.CurrentDoorState.OPENING;
      case 'closing': return Characteristic.CurrentDoorState.CLOSING;
      case 'stopped': return Characteristic.CurrentDoorState.STOPPED;
      default: return Characteristic.CurrentDoorState.CLOSED;
    }
  }

  getDoorStateName(state) {
    const names = {
      [Characteristic.CurrentDoorState.OPEN]: 'open',
      [Characteristic.CurrentDoorState.CLOSED]: 'closed',
      [Characteristic.CurrentDoorState.OPENING]: 'opening',
      [Characteristic.CurrentDoorState.CLOSING]: 'closing',
      [Characteristic.CurrentDoorState.STOPPED]: 'stopped'
    };
    return names[state] || 'unknown';
  }

  // Send command to device
  async sendCommandToDevice(command, params = {}) {
    if (!this.deviceApiUrl) {
      this.log.warn('No device API URL configured, cannot send command:', command);
      return false;
    }

    const payload = { command, ...params };
    const url = this.deviceApiUrl + '/command';
    
    this.log.info(`Sending command to device: ${command}`);
    this.log.info(`POST ${url} with payload:`, JSON.stringify(payload));
    
    try {
      const response = await this.makeHttpRequest(url, 'POST', payload);
      this.log.info('Device response:', JSON.stringify(response));
      return true;
    } catch (error) {
      this.log.error('Failed to send command to device:', error);
      return false;
    }
  }

  // Helper for HTTP requests
  makeHttpRequest(requestUrl, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
      const parsedUrl = url.parse(requestUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const httpModule = isHttps ? https : http;
      
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.path,
        method: method,
        headers: {
          'Content-Type': 'application/json'
        }
      };

      const req = httpModule.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve(body);
          }
        });
      });

      req.on('error', reject);
      
      if (data) {
        req.write(JSON.stringify(data));
      }
      
      req.end();
    });
  }

  // Lock Management Methods
  getLockCurrentState() {
    return this.lockCurrentState;
  }

  getLockTargetState() {
    return this.lockTargetState;
  }

  async setLockTargetState(value) {
    const command = value === Characteristic.LockTargetState.SECURED ? 'lock' : 'unlock';
    await this.sendCommandToDevice(command);
    this.lockTargetState = value;
  }

  // Door Methods
  getCurrentDoorState() {
    return this.currentDoorState;
  }

  getTargetDoorState() {
    return this.targetDoorState;
  }

  async setTargetDoorState(value) {
    if (value === Characteristic.TargetDoorState.CLOSED) {
      this.log.warn('Close command ignored - gate cannot be closed remotely');
      // Immediately revert target back to current state
      setTimeout(() => {
        this.doorService.updateCharacteristic(Characteristic.TargetDoorState, this.currentDoorState);
      }, 100);
      return;
    }
    
    // Handle open command
    this.targetDoorState = value;
    await this.sendCommandToDevice('open');
  }

  triggerDoorbell() {
    this.log.info('Doorbell triggered - access attempt when locked');
    this.doorbellService.updateCharacteristic(
      Characteristic.ProgrammableSwitchEvent, 
      Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS
    );
  }
}