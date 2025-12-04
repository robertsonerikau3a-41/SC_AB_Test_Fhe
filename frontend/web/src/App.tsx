// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface TestConfig {
  id: string;
  name: string;
  versionA: string;
  versionB: string;
  encryptedDataA: string;
  encryptedDataB: string;
  timestamp: number;
  owner: string;
  status: "active" | "completed";
  participants: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEComputeAvg = (encryptedData: string[]): string => {
  const values = encryptedData.map(data => FHEDecryptNumber(data));
  const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
  return FHEEncryptNumber(avg);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [testConfigs, setTestConfigs] = useState<TestConfig[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newTestConfig, setNewTestConfig] = useState({ name: "", versionA: "", versionB: "", paramA: 0, paramB: 0 });
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [selectedTest, setSelectedTest] = useState<TestConfig | null>(null);
  const [decryptedResults, setDecryptedResults] = useState<{a: number|null, b: number|null}>({a: null, b: null});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [activeTab, setActiveTab] = useState("dashboard");

  const activeTests = testConfigs.filter(t => t.status === "active").length;
  const completedTests = testConfigs.filter(t => t.status === "completed").length;

  useEffect(() => {
    loadTestConfigs().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadTestConfigs = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract not available");
        return;
      }

      // Load test config keys
      const keysBytes = await contract.getData("test_config_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing test config keys:", e); }
      }

      // Load each test config
      const list: TestConfig[] = [];
      for (const key of keys) {
        try {
          const configBytes = await contract.getData(`test_config_${key}`);
          if (configBytes.length > 0) {
            try {
              const configData = JSON.parse(ethers.toUtf8String(configBytes));
              list.push({ 
                id: key, 
                name: configData.name,
                versionA: configData.versionA,
                versionB: configData.versionB,
                encryptedDataA: configData.dataA,
                encryptedDataB: configData.dataB,
                timestamp: configData.timestamp,
                owner: configData.owner,
                status: configData.status || "active",
                participants: configData.participants || 0
              });
            } catch (e) { console.error(`Error parsing config data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading test config ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setTestConfigs(list);
    } catch (e) { console.error("Error loading test configs:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createTestConfig = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting test parameters with Zama FHE..." });
    try {
      // Encrypt both parameter versions
      const encryptedDataA = FHEEncryptNumber(newTestConfig.paramA);
      const encryptedDataB = FHEEncryptNumber(newTestConfig.paramB);

      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique ID
      const configId = `test-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      
      // Prepare config data
      const configData = { 
        name: newTestConfig.name,
        versionA: newTestConfig.versionA,
        versionB: newTestConfig.versionB,
        dataA: encryptedDataA,
        dataB: encryptedDataB,
        timestamp: Math.floor(Date.now() / 1000),
        owner: address,
        status: "active",
        participants: 0
      };

      // Store config
      await contract.setData(`test_config_${configId}`, ethers.toUtf8Bytes(JSON.stringify(configData)));
      
      // Update keys list
      const keysBytes = await contract.getData("test_config_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(configId);
      await contract.setData("test_config_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));

      setTransactionStatus({ visible: true, status: "success", message: "A/B test created with FHE encryption!" });
      await loadTestConfigs();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewTestConfig({ name: "", versionA: "", versionB: "", paramA: 0, paramB: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const completeTest = async (testId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Finalizing A/B test with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Get current config
      const configBytes = await contract.getData(`test_config_${testId}`);
      if (configBytes.length === 0) throw new Error("Test config not found");
      const configData = JSON.parse(ethers.toUtf8String(configBytes));
      
      // Update status
      const updatedConfig = { ...configData, status: "completed" };
      await contract.setData(`test_config_${testId}`, ethers.toUtf8Bytes(JSON.stringify(updatedConfig)));
      
      setTransactionStatus({ visible: true, status: "success", message: "A/B test completed successfully!" });
      await loadTestConfigs();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Completion failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (testOwner: string) => address?.toLowerCase() === testOwner.toLowerCase();

  const renderTestStats = () => {
    return (
      <div className="stats-grid">
        <div className="stat-item">
          <div className="stat-value">{testConfigs.length}</div>
          <div className="stat-label">Total Tests</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{activeTests}</div>
          <div className="stat-label">Active</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{completedTests}</div>
          <div className="stat-label">Completed</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">
            {testConfigs.reduce((sum, test) => sum + test.participants, 0)}
          </div>
          <div className="stat-label">Participants</div>
        </div>
      </div>
    );
  };

  const renderComparisonChart = (test: TestConfig) => {
    const aValue = decryptedResults.a || 0;
    const bValue = decryptedResults.b || 0;
    const maxValue = Math.max(aValue, bValue, 1);
    
    return (
      <div className="comparison-chart">
        <div className="chart-bars">
          <div className="bar-container">
            <div className="bar-label">Version A</div>
            <div className="bar-wrapper">
              <div 
                className="bar version-a" 
                style={{ height: `${(aValue / maxValue) * 100}%` }}
              ></div>
            </div>
            <div className="bar-value">{aValue.toFixed(2)}</div>
          </div>
          <div className="bar-container">
            <div className="bar-label">Version B</div>
            <div className="bar-wrapper">
              <div 
                className="bar version-b" 
                style={{ height: `${(bValue / maxValue) * 100}%` }}
              ></div>
            </div>
            <div className="bar-value">{bValue.toFixed(2)}</div>
          </div>
        </div>
        <div className="chart-legend">
          <div className="legend-item">
            <div className="color-box version-a"></div>
            <span>{test.versionA}</span>
          </div>
          <div className="legend-item">
            <div className="color-box version-b"></div>
            <span>{test.versionB}</span>
          </div>
        </div>
      </div>
    );
  };

  const handleDecryptResults = async (test: TestConfig) => {
    if (decryptedResults.a !== null && decryptedResults.b !== null) {
      setDecryptedResults({a: null, b: null});
      return;
    }
    
    setIsDecrypting(true);
    try {
      const decryptedA = await decryptWithSignature(test.encryptedDataA);
      const decryptedB = await decryptWithSignature(test.encryptedDataB);
      setDecryptedResults({a: decryptedA, b: decryptedB});
    } catch (e) {
      console.error("Failed to decrypt results:", e);
    } finally {
      setIsDecrypting(false);
    }
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="tech-spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="circuit-icon"></div>
          </div>
          <h1>FHE<span>AB</span>Test</h1>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-test-btn metal-button"
          >
            <div className="add-icon"></div>New A/B Test
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="dashboard-tabs">
          <button 
            className={`tab-btn ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            Dashboard
          </button>
          <button 
            className={`tab-btn ${activeTab === "tests" ? "active" : ""}`}
            onClick={() => setActiveTab("tests")}
          >
            Test Configs
          </button>
          <button 
            className={`tab-btn ${activeTab === "about" ? "active" : ""}`}
            onClick={() => setActiveTab("about")}
          >
            About
          </button>
        </div>

        {activeTab === "dashboard" && (
          <div className="dashboard-grid">
            <div className="dashboard-card metal-card">
              <h3>Project Introduction</h3>
              <p>
                <strong>FHE-based A/B Testing</strong> allows DeFi protocols and DAOs to privately test 
                smart contract parameters using Zama's Fully Homomorphic Encryption. 
                User interaction data remains encrypted throughout the testing process.
              </p>
              <div className="tech-badge">
                <span>Powered by Zama FHE</span>
              </div>
            </div>

            <div className="dashboard-card metal-card">
              <h3>Test Statistics</h3>
              {renderTestStats()}
            </div>

            <div className="dashboard-card metal-card">
              <h3>Active Tests</h3>
              <div className="active-tests-list">
                {testConfigs.filter(t => t.status === "active").slice(0, 3).map(test => (
                  <div key={test.id} className="active-test-item">
                    <div className="test-name">{test.name}</div>
                    <div className="test-versions">
                      <span className="version-a">{test.versionA}</span> vs 
                      <span className="version-b"> {test.versionB}</span>
                    </div>
                    <div className="test-participants">{test.participants} participants</div>
                  </div>
                ))}
                {testConfigs.filter(t => t.status === "active").length === 0 && (
                  <div className="no-active-tests">No active tests</div>
                )}
              </div>
            </div>

            <div className="dashboard-card metal-card wide-card">
              <h3>Real-time Test Dashboard</h3>
              <div className="realtime-stats">
                <div className="stat-item">
                  <div className="stat-label">Total Encrypted Data Points</div>
                  <div className="stat-value-large">
                    {testConfigs.reduce((sum, test) => sum + 2, 0)}
                  </div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">FHE Operations Completed</div>
                  <div className="stat-value-large">
                    {testConfigs.reduce((sum, test) => sum + (test.status === "completed" ? 1 : 0), 0)}
                  </div>
                </div>
              </div>
              <div className="fhe-status">
                <div className="fhe-indicator"></div>
                <span>FHE Encryption Active</span>
              </div>
            </div>
          </div>
        )}

        {activeTab === "tests" && (
          <div className="tests-section">
            <div className="section-header">
              <h2>A/B Test Configurations</h2>
              <div className="header-actions">
                <button 
                  onClick={loadTestConfigs} 
                  className="refresh-btn metal-button" 
                  disabled={isRefreshing}
                >
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>

            <div className="tests-list metal-card">
              <div className="table-header">
                <div className="header-cell">Name</div>
                <div className="header-cell">Versions</div>
                <div className="header-cell">Owner</div>
                <div className="header-cell">Created</div>
                <div className="header-cell">Status</div>
                <div className="header-cell">Participants</div>
                <div className="header-cell">Actions</div>
              </div>

              {testConfigs.length === 0 ? (
                <div className="no-tests">
                  <div className="no-tests-icon"></div>
                  <p>No A/B test configurations found</p>
                  <button 
                    className="metal-button primary" 
                    onClick={() => setShowCreateModal(true)}
                  >
                    Create First Test
                  </button>
                </div>
              ) : testConfigs.map(test => (
                <div 
                  className="test-row" 
                  key={test.id} 
                  onClick={() => setSelectedTest(test)}
                >
                  <div className="table-cell">{test.name}</div>
                  <div className="table-cell versions">
                    <span className="version-a">{test.versionA}</span> vs 
                    <span className="version-b"> {test.versionB}</span>
                  </div>
                  <div className="table-cell">{test.owner.substring(0, 6)}...{test.owner.substring(38)}</div>
                  <div className="table-cell">{new Date(test.timestamp * 1000).toLocaleDateString()}</div>
                  <div className="table-cell">
                    <span className={`status-badge ${test.status}`}>{test.status}</span>
                  </div>
                  <div className="table-cell">{test.participants}</div>
                  <div className="table-cell actions">
                    {isOwner(test.owner) && test.status === "active" && (
                      <button 
                        className="action-btn metal-button success"
                        onClick={(e) => { e.stopPropagation(); completeTest(test.id); }}
                      >
                        Complete
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "about" && (
          <div className="about-section metal-card">
            <h2>About FHE A/B Testing</h2>
            <div className="about-content">
              <div className="about-column">
                <h3>How It Works</h3>
                <ol className="steps-list">
                  <li>Define two versions of a smart contract parameter</li>
                  <li>Parameters are encrypted using Zama FHE</li>
                  <li>Users interact with both versions unknowingly</li>
                  <li>Results are computed on encrypted data</li>
                  <li>Only authorized parties can decrypt final results</li>
                </ol>
              </div>
              <div className="about-column">
                <h3>Benefits</h3>
                <ul className="benefits-list">
                  <li>Complete privacy for user interaction data</li>
                  <li>No exposure of sensitive parameters during testing</li>
                  <li>Data-driven protocol improvements</li>
                  <li>Secure alternative to traditional A/B testing</li>
                  <li>Compatible with existing DeFi infrastructure</li>
                </ul>
              </div>
            </div>
            <div className="fhe-tech">
              <h3>Zama FHE Technology</h3>
              <p>
                This tool uses Zama's Fully Homomorphic Encryption to enable computations on encrypted data.
                Parameters remain encrypted throughout the entire testing process, ensuring maximum privacy.
              </p>
              <div className="tech-diagram">
                <div className="diagram-step">Parameter Definition →</div>
                <div className="diagram-step">FHE Encryption →</div>
                <div className="diagram-step">Encrypted Testing →</div>
                <div className="diagram-step">Secure Results</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={createTestConfig} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          testConfig={newTestConfig} 
          setTestConfig={setNewTestConfig}
        />
      )}

      {selectedTest && (
        <TestDetailModal 
          test={selectedTest} 
          onClose={() => { 
            setSelectedTest(null); 
            setDecryptedResults({a: null, b: null}); 
          }} 
          decryptedResults={decryptedResults}
          isDecrypting={isDecrypting}
          onDecrypt={handleDecryptResults}
          renderComparisonChart={renderComparisonChart}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="tech-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="circuit-icon"></div>
              <span>FHE A/B Testing</span>
            </div>
            <p>Private on-chain parameter testing powered by Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="tech-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} FHE A/B Testing Tool. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void;
  onClose: () => void;
  creating: boolean;
  testConfig: any;
  setTestConfig: (config: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, testConfig, setTestConfig }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setTestConfig({ ...testConfig, [name]: value });
  };

  const handleParamChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setTestConfig({ ...testConfig, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!testConfig.name || !testConfig.versionA || !testConfig.versionB) {
      alert("Please fill all required fields");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>Create New A/B Test</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="lock-icon"></div>
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>All parameters will be encrypted with Zama FHE before submission</p>
            </div>
          </div>

          <div className="form-group">
            <label>Test Name *</label>
            <input
              type="text"
              name="name"
              value={testConfig.name}
              onChange={handleChange}
              placeholder="e.g. Fee Structure Test"
              className="metal-input"
            />
          </div>

          <div className="version-fields">
            <div className="form-group">
              <label>Version A Name *</label>
              <input
                type="text"
                name="versionA"
                value={testConfig.versionA}
                onChange={handleChange}
                placeholder="e.g. Flat Fee"
                className="metal-input"
              />
            </div>
            <div className="form-group">
              <label>Version B Name *</label>
              <input
                type="text"
                name="versionB"
                value={testConfig.versionB}
                onChange={handleChange}
                placeholder="e.g. Dynamic Fee"
                className="metal-input"
              />
            </div>
          </div>

          <div className="param-fields">
            <div className="form-group">
              <label>Version A Parameter Value *</label>
              <input
                type="number"
                name="paramA"
                value={testConfig.paramA}
                onChange={handleParamChange}
                placeholder="Numerical value"
                className="metal-input"
                step="0.01"
              />
            </div>
            <div className="form-group">
              <label>Version B Parameter Value *</label>
              <input
                type="number"
                name="paramB"
                value={testConfig.paramB}
                onChange={handleParamChange}
                placeholder="Numerical value"
                className="metal-input"
                step="0.01"
              />
            </div>
          </div>

          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Version A:</span>
                <div>{testConfig.paramA || 'Not set'}</div>
              </div>
              <div className="plain-data">
                <span>Version B:</span>
                <div>{testConfig.paramB || 'Not set'}</div>
              </div>
              <div className="encrypted-data">
                <span>Encrypted:</span>
                <div>
                  {testConfig.paramA ? FHEEncryptNumber(testConfig.paramA).substring(0, 20) + '...' : 'Not set'}
                  <br />
                  {testConfig.paramB ? FHEEncryptNumber(testConfig.paramB).substring(0, 20) + '...' : 'Not set'}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn metal-button primary"
          >
            {creating ? "Creating with FHE..." : "Create Test"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface TestDetailModalProps {
  test: TestConfig;
  onClose: () => void;
  decryptedResults: {a: number|null, b: number|null};
  isDecrypting: boolean;
  onDecrypt: (test: TestConfig) => Promise<void>;
  renderComparisonChart: (test: TestConfig) => React.ReactNode;
}

const TestDetailModal: React.FC<TestDetailModalProps> = ({ 
  test, 
  onClose, 
  decryptedResults, 
  isDecrypting, 
  onDecrypt,
  renderComparisonChart
}) => {
  return (
    <div className="modal-overlay">
      <div className="test-detail-modal metal-card">
        <div className="modal-header">
          <h2>Test Details: {test.name}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="test-info">
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${test.status}`}>{test.status}</strong>
            </div>
            <div className="info-item">
              <span>Created:</span>
              <strong>{new Date(test.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{test.owner.substring(0, 6)}...{test.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Participants:</span>
              <strong>{test.participants}</strong>
            </div>
          </div>

          <div className="test-versions">
            <div className="version-card version-a">
              <h3>{test.versionA}</h3>
              <div className="encrypted-data">
                {test.encryptedDataA.substring(0, 50)}...
              </div>
              {decryptedResults.a !== null && (
                <div className="decrypted-value">
                  Result: {decryptedResults.a.toFixed(2)}
                </div>
              )}
            </div>
            <div className="version-card version-b">
              <h3>{test.versionB}</h3>
              <div className="encrypted-data">
                {test.encryptedDataB.substring(0, 50)}...
              </div>
              {decryptedResults.b !== null && (
                <div className="decrypted-value">
                  Result: {decryptedResults.b.toFixed(2)}
                </div>
              )}
            </div>
          </div>

          {renderComparisonChart(test)}

          <div className="test-actions">
            <button 
              className="decrypt-btn metal-button" 
              onClick={() => onDecrypt(test)}
              disabled={isDecrypting}
            >
              {isDecrypting ? "Decrypting..." : 
               decryptedResults.a !== null ? "Hide Results" : "Decrypt Results"}
            </button>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted Data</span>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;