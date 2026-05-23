All portability rules upheld: no child_process in src/, all 3 signal handlers wired, env-paths confined to paths.js,  
  path.sep used for boundary checks, drive-letter + UNC paths accepted.                                               
                                                                                                                        
  Build summary                                                                                                         
                                                                                                                        
  All 8 tasks completed. Tests: 33/33 pass (npm test).                                                                  
                                                                                                                        
  Implemented modules (per spec §6):                                                                                    
  - paths.js (env-paths wrapper, the only OS-aware file in src/)                                                        
  - prefixSum.js (pure, 7 tests including zero-count and out-of-range)                                                  
  - indexer.js (depth-2 walk, atomic persist with EXDEV fallback)                                                     
  - selector.js (sequential + weighted random, 50-deep history, ±2% statistical test on 10k picks)                      
  - cache.js (LRU buffers for images; 16 MB page-cache prime for videos, no buffering)                                  
  - state.js (load/persist runtime state with strip of connectedClients)                                                
  - config.js (env override layer)                                                                                      
  - log.js (one-line JSON to stdout/stderr)                                                                             
  - routes/admin.js (setup, dirs, drives, root, reindex, status, config)                                                
  - routes/stream.js (HTTP Range with malformed→416 / past-EOF→416 / open-ended→EOF, HEIC→JPEG, ETag, traversal block)
  - ws.js (/ctrl, 15s ping with 2-pong drop, show/volume/paused/mode/status/error)                                      
  - server.js (3-signal shutdown: SIGTERM, SIGINT, SIGBREAK)                                                            
                                                                                                                        
  Frontend (vanilla, ES2019, Chromium 87 safe): setup page with drive picker + folder browser + indexing-progress poll; 
  TV slideshow with two-layer crossfade, hidden preloader, folder + clock overlays, exponential-backoff reconnect.      
                                                                                                                        
  Platform layers:                                                                                                      
  - Windows: install.ps1 (NSSM download + SERVICE_DEMAND_START + rotating logs), uninstall.ps1, start/stop/status.bat.
  Bash-validated.                                                                                                       
  - Linux: install.sh (NodeSource Node 20 + apt ffmpeg + rsync to /opt/slideshow + render unit template), uninstall.sh,
  slideshow.service.tmpl (Type=simple, SIGTERM, no WantedBy auto-enable), README-fstab.md. bash -n passes on both shell 
  scripts.                                                                                                              
          
  End-to-end smoke verified live on this machine: server boots, /api/status returns config, setup page served at /,     
  picking a fixture root indexes 3 folders / 4 files in <10 ms, image fetch returns the right bytes, traversal attempts 
  get 400, SIGTERM shuts down cleanly. Acceptance criteria that cannot be checked on macOS (NSSM, Magic Remote, 400 GB
  on USB 3.0) remain for the Windows 11 install. Repo is ready to copy onto the NUC. 