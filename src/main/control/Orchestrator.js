// import { ipcRenderer } from 'electron';
import Mission from './Mission';
import Vehicle from './Vehicle';
import MessageHandler from './MessageHandler';
import ISRMission from './Missions/ISRMission';
import UpdateHandler from './DataStructures/UpdateHandler';

// Load the vehicle database
const { VEHICLE_DATABASE } = require('../../../resources/vehicles.json');

export default class Orchestrator {
  static log(failureMessage) {
    const ipcMessage = {
      type: 'failure',
      message: failureMessage,
    };
    console.log('FAILURE: (in Class `Orchestrator`) ', failureMessage);
    // ipcRenderer.send('post', 'updateMessages', ipcMessage);
  }

  /**
   * Get the instance of the singleton Orchestrator.
   *
   * @returns {Orchestrator} the singleton instance
   */
  static getInstance() {
    if (Orchestrator.instance === undefined) {
      Orchestrator.singletonUnlock = true;
      Orchestrator.instance = new Orchestrator();
      Orchestrator.singletonUnlock = false;
    }
    return Orchestrator.instance;
  }

  /**
    *   Creates an instance of an Orchestrator
    *   @constructor
    *   @this {Orchestrator}
    */
  constructor() {
    if (Orchestrator.singletonUnlock !== true) {
      throw new Error('Orchestrator must be acquired with the getInstance() method!');
    }

    this.scheduledMissions = [];
    // Store the statuses of each mission; object are in the same order as the scheduledMissions
    this.scheduledMissionsStatus = [];

    this.currentMission = null;
    this.currentMissionIndex = 0;
    this.currentMissionVehicles = null;
    this.nextMissionRequiredData = null;
    this.knownVehicles = [];

    // Get the MessageHandlerInstance & set the orchestrator message handler to this
    MessageHandler.getInstance().setMessageHandler(this.processMessage.bind(this));

    // boolean indicator for whether a mission is actively running
    this.isRunning = false;

    // get the constructors of each mission and put them in order(?)
    this.missionObjects = { ISRMission: ISRMission };

    this.vehicleStatusUpdater = new UpdateHandler();
  }

  /**
    *   Getter for the scheduledMissions member variable.
    *   @this {Orchestrator}
    *   @returns {list} scheduledMissions: The list of scheduled Missions
    */
  getScheduledMissions() {
    return this.scheduledMissions;
  }

  /**
   *  Getter for the knownVehicles member variable.
   *  @this {Orchestrator}
   *  @returns {list} knownVehicles: The list of known Vehicles.
   */
  getKnownVehicles() {
    return this.knownVehicles;
  }

  /**
   * Add task to check the last time a given vehicle has checked in
   * @param {Vehicle} vehicle The Vehicle to check.
   */
  pingAgain_f(vehicle) {
    if ((((vehicle !== undefined) && (vehicle !== null)) && !(vehicle instanceof Vehicle)) || (!vehicle.isActive)) {
      Orchestrator.log(`Refusing to re-schedule task to check on vehicle with ID: ${vehicle.vehicleId}; is invalid not active`);
    } else {
      const delta = Date.now() - vehicle.lastConnTime;
      if ((delta >= 0) && (delta <= vehicle.vehicleTimeoutLength)) {
        // Vehicle has connected w/in the last 30 seconds, schedule to ping again at expiring time
        this.vehicleStatusUpdater.addHandler(vehicle.vehicleId, () => this.pingAgain_f(vehicle), () => this.pingAgain_f(vehicle), delta);
      } else {
        // Vehicle has NOT sent ANY message (or none were received), mark vehicle as deactivated
        this.deactivateVehicle(vehicle);
      }
    }
  }

  /**
   * Adds a vehicle to the known vehicle list.
   * @TODO Add isActive polling (i.e., task to check if the Vehicle is disconnected/lost comms/etc.)
   * @this {Orchestrator}
   * @param {Vehicle} vehicle:   The vehicle to add to the list
   */
  addVehicle(vehicle) {
    this.vehicleStatusUpdater.addHandler(vehicle.vehicleId, () => this.pingAgain_f(vehicle), () => this.pingAgain_f(vehicle), 1000);
    this.knownVehicles.push(vehicle);
  }

  /**
   *    Marks a vehicle not active and unavailable for tasking.
   *    @this {Orchestrator}
   *    @param {Vehicle} vehicle:   The vehicle to deactivate
   */
  deactivateVehicle(vehicle) {
    // Keep vehicle as a known vehicle, but mark it as inactive so that
    // if it comes back online it can be disabled
    vehicle.setActive(false);
    vehicle.setAvailable(false);
  }

  /*
  FLOW:
  1. User selects the missions to create.
  2. The mission is constructed (but not initialized with any data)
  3. The user input data from the mission setup is used to set up the mission
  4. When the user clicks 'next', the mission is initialized (sets up listening for status)
  5. When user has gone through all the screens, display a 'overview' of the mission selected and their status
  5a. Prevent user from going forward (completing setup) until all missions have been accepted & READY.
  */

  /**
   * Creates & returns a new mission object of the speicfied type.
   *
   * @param  {string} missionName name of the mission to create, e.g. 'ISRMission'
   * @returns  {Mission} the mission number for later identification. Starts at 0.
   */
  createMission(missionName) {
    if (this.isRunning) {
      Orchestrator.log('Cannot create new mission when mission is actively running');
      return null;
    }

    const missionConstructor = this.missionObjects[missionName];
    if (missionConstructor === undefined) {
      Orchestrator.log(`In Class 'Orchestrator', method 'createMission': Received request to construct mission object for: ${missionName}; but class is not defined`);
      return null;
    } else {
      return new missionConstructor(this.endMission.bind(this), this.knownVehicles, this);
    }
  }

  /**
   * Attempt to apply the current mission settings.
   * If successful, it will return true, otherwise it returns a string with
   * more infomation on the failure.
   *
   * @param {integer} missionNumber the number of the mission
   * @param {Object} missionSettings the options/settings for the current mission
   * @param {Object} missionVehicles the mapping of vehicles to mission/job strings
   *
   * @returns {boolean|string} true   if the mission is valid and ready;
   *                           String message indicating what went wrong otherwise
   */
  /* ======================================================================== */
  /* |               MOVING THIS FUNCTION OUT OF ORCHESTRATOR               | */
  /* ======================================================================== */
  applyMissionSetupDONTCALL(missionNumber, missionSettings, missionVehicles) {
    if (this.isRunning) {
      Orchestrator.log('Cannot apply mission setup when mission is actively running');
      return 'Internal Error: Mission setting applied when mission already running';
    }

    const missionObj = this.scheduledMissions[missionNumber];
    if (missionObj === undefined) {
      Orchestrator.log(`In Class 'Orchestrator', method 'applyMissionSetup': Invalid mission number: ${missionNumber}`);
      return 'Internal Error: Invalid mission number';
    } else {
      try {
        missionObj.setMissionInfo(missionSettings);
        missionObj.setVehicleMapping(missionVehicles);
      } catch (err) {
        Orchestrator.log(`In Class 'Orchestrator', method 'applyMissionSetup': ${err.message} ${err}`);
      }
      return missionObj.missionSetupComplete();
    }
  }

  /**
    *   Adds a mission to be executed.
    *   Initializes the mission and sets up a listener for every time the status
    *   is updated so that if it enters an invalid state, it can be handled early.
    *
    *   Should be called from the UI Driver
    *
    *   @TODO: Do ordering on the missions (e.g., quickSearch should be executed before detailedSearch)
    *   @this {Orchestrator}
    *   @param {Array} missions list of all the missions to be added; the missions should be already set up
    */
  addMissions(missions) {
    if (this.isRunning) {
      Orchestrator.log('In Class \'Orchestrator\', method \'addMissions\':Cannot add missions when a mission is actively running');
      return;
    }

    for (let i = 0; i < missions.length; i++) {
      const mission = missions[i];

      if (!(mission instanceof Mission)) {
        Orchestrator.log(`In Class 'Orchestrator', method 'addMissions': Received an object constructed with: ${mission.constructor.name}; expected object of type 'Mission' or subclass. Aborting...`);
        // reset!
        this.reset();
        return;
      }

      if (mission.missionSetupComplete() !== true) {
        Orchestrator.log(`In Class 'Orchestrator', method 'addMissions': The mission: ${mission.constructor.name} is expected to be completely set up prior to adding. Aborting...`);
        // reset!
        this.reset();
        return;
      }

      const missionIndex = this.scheduledMissions.push(mission) - 1;
      this.scheduledMissionsStatus.push(mission.status);
      mission.listenForStatusUpdates(status => {
        if (status === 'READY') {
          // TODO: add logic for when becomes ready
          this.scheduledMissionsStatus[missionIndex] = status;
        } else {
          // TODO: add logic for when becomes not ready
          this.scheduledMissionsStatus[missionIndex] = status;
        }
        // continue listening to status updates
        return false;
      });
    }
  }

  /**
    *   Get whether all the missions are ready or not
    *
    *   @returns {boolean} true if all the scheduled missions are ready
    */
  allMissionsAreReady() {
    let allAreReady = true;
    for (const status of this.scheduledMissionsStatus) {
      allAreReady = allAreReady && status === 'READY';
    }
    return allAreReady;
  }

  /**
    *   Checks a Mission for complete data, then starts it.
    *   @this {Orchestrator}
    *   @param {JSON} requiredData the data required by the current Mission (the Mission that is to be started).
    */
  startMission(requiredData) {
    // Assume that the mission is still okay if the status of the mission is READY
    if (this.scheduledMissions[this.currentMissionIndex].status === 'READY') {
      this.isRunning = true;
      // Update the current running mission
      this.currentMission = this.scheduledMissions[this.currentMissionIndex];
      this.currentMission.missionStart(requiredData);
      this.currentMissionVehicles = this.currentMission.getMissionActiveVehicles();
    } else {
      // Not running anymore because a mission wasnt READY to start
      this.isRunning = false;
      // either attempt recovery, or just do a reset?
      Orchestrator.log(this.currentMissionName(), ' mission could not be started due because it is not in a READY state!');
    }
  }

  /**
    *   Handles when a Mission ends; forwarding the data to the next mission
    *   scheduled to start (if present)
    *   @this {Orchestrator}
    *   @param {Object} nextRequired: The data required by the next Mission (the next Mission that is to be started).
    */
  endMission(nextRequired) {
    this.nextMissionRequiredData = nextRequired;
    this.currentMissionIndex++;
    if (this.scheduledMissions.length < this.currentMissionIndex) {
      this.startMission(nextRequired);
    } else {
      // End of missions -- reset
      this.reset();
    }
  }

  /**
    * Reset the Orchestrator to initial state so that missions can be
    * added again.
    */
  reset() {
    this.isRunning = false;
    this.currentMission = null;
    this.currentMissionIndex = 0;
    this.currentMissionVehicles = null;
    this.scheduledMissions = [];
    this.scheduledMissionsStatus = [];
    this.nextMissionRequiredData = null;
  }

  /**
    *   Getter for the name of the current Mission
    *   @this {Orchestrator}
    *   @returns {string} currentMissionName: the name of the current Mission
    */
  currentMissionName() {
    return this.currentMission.name;
  }

  /**
   *    Returns a Vehicle object based on its ID
   *    @param {int} vID: vehicle ID
   *    @returns {Vehicle} v: non-null on success; null on failure
   */
  getVehicleByID(vID) {
    for (const v of this.knownVehicles) {
      if (v.id === vID) {
        return v;
      }
    }
    return null;
  }

  /**
   * Processed a message from the MessageHandler.
   *
   * @param {Object} message the message being received from the MessageHandler
   */
  processMessage(message) {
    // Look up the vehicle
    const vehc = this.getVehicleByID(message.sid);
    const msgStr = message.type.toUpperCase();
    const messageHandler = MessageHandler.getInstance();

    if (msgStr === 'CONNECT') {
      /*
        A new vehicle is attempting to connect; create a new vehicle object if
        and only if ID is found in the Database & an active vehicle has not allocated
        the ID already.
        In many cases, the sending vehicle will not have been defined yet.
      */
      if (vehc !== undefined && vehc.isActive) {
        // Do nothing; the vehicle with that ID is already in the system
        Orchestrator.log(`In Class 'Orchestrator', method 'processMessage': Received a connection message for VID: ${message.sid}, but a vehicle with the ID is already active`);
        return;
      }
      // remove vehicle from the known vehicle list (if present) to be replaced
      this.knownVehicles = this.knownVehicles.filter(v => v.id !== message.sid);

      const newVehc = new Vehicle(message.sid, message.jobsAvailable, 'WAITING');
      this.knownVehicles.push(newVehc);
      // Send a connection acknowledgment message to the target
      messageHandler.sendMessageTo(message.sid, { type: 'connectionAck' });
    } else {
      // Every other message kind requires that the sender is defined -- verify that this is the case
      if (vehc === undefined || vehc === null) {
        Orchestrator.log(`In Class 'Orchestrator', method 'processMessage': Received an update for VID: ${message.sid}, but no vehicle is registered for the ID`);
        return;
      } else if (!vehc.isActive) {
        // Vehicle should be inactive
        Orchestrator.log(`In Class 'Orchestrator', method 'processMessage': Received an update message for inactive vehicle with VID: ${message.sid}; sending stop...`);
        // Send vehicle a stop message
        messageHandler.sendMessageTo(vehc.id, { type: 'stop' });
        return;
      }

      if (msgStr === 'UPDATE') {
        /*
          Update message are sent directly to the vehicle that it represents.
        */
        vehc.vehicleUpdate(message);
      } else if (msgStr === 'POI' || msgStr === 'COMPLETE') {
        /*
          Complete and POI messages are only considered if they are sent from vehicles
          that are part of an active mission. The message is then sent to the current
          mission.
        */
        if (message.sid in this.currentMissionVehicles) {
          // Update the current mission that a complete message was received
          this.scheduledMissions[this.currentMissionIndex].missionUpdate(message);
        }
      }
    }
  }

  // //////////////////////////////////////////////////////////////////////////////
  // MOVE THE FOLLOWING TO MESSAGEHANDLER
  // //////////////////////////////////////////////////////////////////////////////

  /**
    *   Sends/Schedules to send a message to a Vehicle.
    *   @this {Orchestrator}
    *   @param {string} vehicleID: the unique ID (UID) for the vehicle to send the `message` to.
    *   @param {JSON} message: the message to send to the vehicle with UID `vehicleID`
    */
  sendMessage(vehicleID, message) {
    this.getVehicleByID(vehicleID).sendMessage(message);
  }

  /**
    *   Processes a given message from a vehicle
    *   @TODO: Add support for messages from other vehicles (only VTOL currently)
    *   @this {Orchestrator}
    *   @param {JSON} message: The message that was received from the vehicle
    */
  handleReceivedMessage(message) {
    const srcVehicle = this.getVehicleByID(message.srcVehicleID);
    const ackMessage = { type: 'ack', received: message.type };
    this.sendMessage(message.srcVehicleID, ackMessage);
    switch (message.type) {
      case 'UPDATE' || 'update':
        if (!srcVehicle.isActive()) {
          this.sendMessage(message.srcVehicleID, { type: 'STOP' });
        }
        break;
      case 'ACK' || 'ack':
        srcVehicle.acknowledged(message.type);
        break;
      case 'CONNECT' || 'connect':
        this.addVehicle(new Vehicle(message.srcVehicleID, message.vehicleType, message.jobsAvailable));
        break;
      case 'POI' || 'poi':
        this.nextMissionRequiredData.poi.push({ lat: message.lat, lon: message.lon });
        break;
      case 'COMPLETE' || 'complete':
        srcVehicle.setAvailable(true);
        this.scheduledMissions[this.currentMissionIndex].vehicleUpdate();
        break;
      default:
        Orchestrator.log(`Unhandled (bad?) message received from vehicle: ${message.srcVehicleID}  with contents of : ${message}`);
        this.sendMessage(message.srcVehicleID, { type: 'badMessage', error: 'Bad message type' });
    }
  }
}
