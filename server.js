const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 미들웨어 설정
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 루트 경로 핸들러 추가
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 헬스 체크 엔드포인트
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// SQLite 데이터베이스 설정 (Render 환경 대응)
let db;
try {
  db = new sqlite3.Database('chat.db', (err) => {
    if (err) {
      console.log('SQLite 데이터베이스 초기화 실패, 메모리 기반으로 전환:', err.message);
      db = null;
    } else {
      console.log('SQLite 데이터베이스에 성공적으로 연결되었습니다.');
      // 데이터베이스 초기화
      db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          socket_id TEXT UNIQUE,
          username TEXT,
          latitude REAL,
          longitude REAL,
          last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
          if (err) {
            console.log('users 테이블 생성 오류:', err.message);
          } else {
            console.log('users 테이블이 준비되었습니다.');
          }
        });
        
        db.run(`CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sender_id TEXT,
          sender_name TEXT,
          message TEXT,
          latitude REAL,
          longitude REAL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
          if (err) {
            console.log('messages 테이블 생성 오류:', err.message);
          } else {
            console.log('messages 테이블이 준비되었습니다.');
          }
        });
      });
    }
  });
} catch (error) {
  console.log('SQLite 데이터베이스 초기화 실패, 메모리 기반으로 전환:', error.message);
  db = null;
}

if (!db) {
  console.log('데이터베이스 없이 메모리 기반으로 실행됩니다.');
}

// 연결된 사용자들을 저장하는 객체
const connectedUsers = new Map();

// 두 지점 간의 거리 계산 (미터 단위)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // 지구 반지름 (미터)
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// 근처 사용자 찾기 (30m 이내)
function findNearbyUsers(latitude, longitude, excludeSocketId = null) {
  const nearbyUsers = [];
  
  connectedUsers.forEach((user, socketId) => {
    if (socketId !== excludeSocketId && user.latitude && user.longitude) {
      const distance = calculateDistance(latitude, longitude, user.latitude, user.longitude);
      if (distance <= 30) { // 30미터 이내
        nearbyUsers.push({
          socketId,
          username: user.username,
          distance: Math.round(distance),
          latitude: user.latitude,
          longitude: user.longitude
        });
      }
    }
  });
  
  return nearbyUsers;
}

// Socket.IO 연결 처리
io.on('connection', (socket) => {
  console.log('새로운 사용자가 연결되었습니다:', socket.id);

  // 사용자 등록
  socket.on('register', (data) => {
    const { username, latitude, longitude } = data;
    
    connectedUsers.set(socket.id, {
      username,
      latitude,
      longitude,
      lastSeen: new Date()
    });

    // 데이터베이스에 사용자 정보 저장
    if (db) {
      db.run(
        'INSERT OR REPLACE INTO users (socket_id, username, latitude, longitude, last_seen) VALUES (?, ?, ?, ?, ?)',
        [socket.id, username, latitude, longitude, new Date().toISOString()]
      );
    }

    // 근처 사용자들에게 새 사용자 알림
    const nearbyUsers = findNearbyUsers(latitude, longitude, socket.id);
    nearbyUsers.forEach(user => {
      io.to(user.socketId).emit('userJoined', {
        socketId: socket.id,
        username,
        distance: user.distance
      });
    });

    // 새 사용자에게 근처 사용자 목록 전송
    socket.emit('nearbyUsers', nearbyUsers);
    
    console.log(`${username}님이 등록되었습니다. (${latitude}, ${longitude})`);
  });

  // 위치 업데이트
  socket.on('updateLocation', (data) => {
    const { latitude, longitude } = data;
    const user = connectedUsers.get(socket.id);
    
    if (user) {
      user.latitude = latitude;
      user.longitude = longitude;
      user.lastSeen = new Date();
      
      // 데이터베이스 업데이트
      if (db) {
        db.run(
          'UPDATE users SET latitude = ?, longitude = ?, last_seen = ? WHERE socket_id = ?',
          [latitude, longitude, new Date().toISOString(), socket.id]
        );
      }

      // 근처 사용자들에게 위치 업데이트 알림
      const nearbyUsers = findNearbyUsers(latitude, longitude, socket.id);
      nearbyUsers.forEach(nearbyUser => {
        io.to(nearbyUser.socketId).emit('userLocationUpdated', {
          socketId: socket.id,
          username: user.username,
          latitude,
          longitude,
          distance: nearbyUser.distance
        });
      });
    }
  });

  // 메시지 전송
  socket.on('sendMessage', (data) => {
    const { message } = data;
    const user = connectedUsers.get(socket.id);
    
    if (user && user.latitude && user.longitude) {
      const nearbyUsers = findNearbyUsers(user.latitude, user.longitude, socket.id);
      
      // 근처 사용자들에게 메시지 전송
      const messageData = {
        senderId: socket.id,
        senderName: user.username,
        message,
        latitude: user.latitude,
        longitude: user.longitude,
        timestamp: new Date().toISOString()
      };

      nearbyUsers.forEach(nearbyUser => {
        io.to(nearbyUser.socketId).emit('newMessage', messageData);
      });

      // 발신자에게도 메시지 전송 (확인용)
      socket.emit('messageSent', messageData);

      // 데이터베이스에 메시지 저장
      if (db) {
        db.run(
          'INSERT INTO messages (sender_id, sender_name, message, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
          [socket.id, user.username, message, user.latitude, user.longitude, new Date().toISOString()]
        );
      }

      console.log(`${user.username}: ${message}`);
    }
  });

  // 근처 사용자 목록 요청
  socket.on('getNearbyUsers', () => {
    const user = connectedUsers.get(socket.id);
    if (user && user.latitude && user.longitude) {
      const nearbyUsers = findNearbyUsers(user.latitude, user.longitude, socket.id);
      socket.emit('nearbyUsers', nearbyUsers);
    }
  });

  // 연결 해제
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      // 근처 사용자들에게 사용자 퇴장 알림
      const nearbyUsers = findNearbyUsers(user.latitude, user.longitude, socket.id);
      nearbyUsers.forEach(nearbyUser => {
        io.to(nearbyUser.socketId).emit('userLeft', {
          socketId: socket.id,
          username: user.username
        });
      });

      connectedUsers.delete(socket.id);
      console.log(`${user.username}님이 연결을 해제했습니다.`);
    }
  });
});

// API 라우트
app.get('/api/users', (req, res) => {
  const users = Array.from(connectedUsers.entries()).map(([socketId, user]) => ({
    socketId,
    username: user.username,
    latitude: user.latitude,
    longitude: user.longitude,
    lastSeen: user.lastSeen
  }));
  res.json(users);
});

app.get('/api/messages', (req, res) => {
  const { lat, lon, radius = 30 } = req.query;
  
  if (lat && lon && db) {
    db.all(
      'SELECT * FROM messages WHERE timestamp > datetime("now", "-1 hour") ORDER BY timestamp DESC LIMIT 50',
      (err, rows) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }
        
        // 위치 기반 필터링
        const filteredMessages = rows.filter(row => {
          const distance = calculateDistance(parseFloat(lat), parseFloat(lon), row.latitude, row.longitude);
          return distance <= radius;
        });
        
        res.json(filteredMessages);
      }
    );
  } else {
    res.status(400).json({ error: '위도와 경도가 필요합니다.' });
  }
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

console.log('서버 시작 준비 중...');
console.log(`PORT: ${PORT}`);
console.log(`HOST: ${HOST}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV || 'development'}`);

server.listen(PORT, HOST, () => {
  console.log(`✅ 서버가 포트 ${PORT}에서 성공적으로 실행 중입니다.`);
  console.log(`환경: ${process.env.NODE_ENV || 'development'}`);
  if (process.env.NODE_ENV === 'production') {
    console.log(`🚀 프로덕션 서버가 실행 중입니다.`);
  } else {
    console.log(`🌐 http://localhost:${PORT}에서 접속하세요.`);
  }
  console.log(`💚 헬스 체크: http://localhost:${PORT}/health`);
}).on('error', (error) => {
  console.error('❌ 서버 시작 오류:', error);
  console.error('오류 코드:', error.code);
  console.error('오류 메시지:', error.message);
  process.exit(1);
});
