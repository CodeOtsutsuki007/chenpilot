// chenpilot/src/Operations/deployment/__tests__/deploymentManager.test.ts
import {
  DeploymentManager,
  DeploymentStatus,
  DeploymentConfig,
} from "../deploymentManager";

describe("DeploymentManager", () => {
  let manager: DeploymentManager;

  beforeEach(() => {
    manager = new DeploymentManager("1.0.0");
  });

  describe("registerInstance", () => {
    it("should register an instance", () => {
      manager.registerInstance("instance-1", "1.0.0");

      const instance = manager.getInstanceState("instance-1");
      expect(instance).toBeDefined();
      expect(instance?.instanceId).toBe("instance-1");
      expect(instance?.version).toBe("1.0.0");
      expect(instance?.status).toBe(DeploymentStatus.IDLE);
    });

    it("should allow multiple instances", () => {
      manager.registerInstance("instance-1", "1.0.0");
      manager.registerInstance("instance-2", "1.0.0");

      const instances = manager.getAllInstances();
      expect(instances).toHaveLength(2);
    });
  });

  describe("unregisterInstance", () => {
    it("should unregister an instance", () => {
      manager.registerInstance("instance-1", "1.0.0");
      manager.unregisterInstance("instance-1");

      const instance = manager.getInstanceState("instance-1");
      expect(instance).toBeUndefined();
    });
  });

  describe("updateActiveConnections", () => {
    it("should update connection count", () => {
      manager.registerInstance("instance-1", "1.0.0");
      manager.updateActiveConnections("instance-1", 10);

      const instance = manager.getInstanceState("instance-1");
      expect(instance?.activeConnections).toBe(10);
    });
  });

  describe("getInstancesByVersion", () => {
    it("should filter instances by version", () => {
      manager.registerInstance("instance-1", "1.0.0");
      manager.registerInstance("instance-2", "1.0.0");
      manager.registerInstance("instance-3", "2.0.0");

      const v1Instances = manager.getInstancesByVersion("1.0.0");
      expect(v1Instances).toHaveLength(2);

      const v2Instances = manager.getInstancesByVersion("2.0.0");
      expect(v2Instances).toHaveLength(1);
    });
  });

  describe("startDrain", () => {
    it("should start draining an instance", async () => {
      manager.registerInstance("instance-1", "1.0.0");
      manager.updateActiveConnections("instance-1", 5);

      const config: DeploymentConfig = {
        instanceId: "instance-1",
        targetVersion: "2.0.0",
        drainTimeoutMs: 1000,
        minHealthyInstances: 1,
        enableVersionFencing: false,
      };

      // Update connections to 0 after short delay
      setTimeout(() => {
        manager.updateActiveConnections("instance-1", 0);
      }, 100);

      await manager.startDrain("instance-1", config);

      const instance = manager.getInstanceState("instance-1");
      expect(instance?.status).toBe(DeploymentStatus.DRAINING);
    });

    it("should throw if instance not found", async () => {
      const config: DeploymentConfig = {
        instanceId: "nonexistent",
        targetVersion: "2.0.0",
        drainTimeoutMs: 1000,
        minHealthyInstances: 1,
        enableVersionFencing: false,
      };

      await expect(manager.startDrain("nonexistent", config)).rejects.toThrow(
        "Instance nonexistent not found"
      );
    });
  });

  describe("enableVersionFencing", () => {
    it("should enable version fencing", () => {
      manager.registerInstance("instance-1", "1.0.0");
      manager.enableVersionFencing("instance-1", "2.0.0");

      const instance = manager.getInstanceState("instance-1");
      expect(instance?.status).toBe(DeploymentStatus.FENCED);
    });
  });

  describe("shouldAcceptRequest", () => {
    it("should accept requests from idle instances", () => {
      manager.registerInstance("instance-1", "1.0.0");

      const shouldAccept = manager.shouldAcceptRequest("instance-1");
      expect(shouldAccept).toBe(true);
    });

    it("should reject requests from fenced instances with wrong version", () => {
      manager.registerInstance("instance-1", "1.0.0");
      manager.enableVersionFencing("instance-1", "2.0.0");

      const shouldAccept = manager.shouldAcceptRequest("instance-1", "2.0.0");
      expect(shouldAccept).toBe(false);
    });

    it("should accept requests from fenced instances with matching version", () => {
      manager.registerInstance("instance-1", "2.0.0");
      manager.enableVersionFencing("instance-1", "2.0.0");

      const shouldAccept = manager.shouldAcceptRequest("instance-1", "2.0.0");
      expect(shouldAccept).toBe(true);
    });
  });

  describe("executeDeployment", () => {
    it("should execute successful deployment", async () => {
      manager.registerInstance("instance-1", "1.0.0");
      manager.registerInstance("instance-2", "1.0.0");
      manager.updateActiveConnections("instance-1", 0);
      manager.updateActiveConnections("instance-2", 0);

      const config: DeploymentConfig = {
        instanceId: "instance-1",
        targetVersion: "2.0.0",
        drainTimeoutMs: 1000,
        minHealthyInstances: 1,
        enableVersionFencing: false,
      };

      const result = await manager.executeDeployment(config);

      expect(result.success).toBe(true);
      expect(manager.getCurrentVersion()).toBe("2.0.0");
    });

    it("should fail with insufficient healthy instances", async () => {
      const config: DeploymentConfig = {
        instanceId: "instance-1",
        targetVersion: "2.0.0",
        drainTimeoutMs: 1000,
        minHealthyInstances: 2,
        enableVersionFencing: false,
      };

      const result = await manager.executeDeployment(config);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Insufficient healthy instances");
    });
  });
});
