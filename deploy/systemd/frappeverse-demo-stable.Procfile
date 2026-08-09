redis_cache: redis-server config/redis_cache.conf
redis_queue: redis-server config/redis_queue.conf
web: bench serve --noreload --port 8201
socketio: /home/goblin/.nvm/versions/node/v24.17.0/bin/node apps/frappe/socketio.js
schedule: bench schedule
worker: bench worker 1>> logs/worker.log 2>> logs/worker.error.log
