-- machine_id 기반 RLS 정책 업데이트
-- 이 마이그레이션은 001_create_approval_requests.sql 이후 실행되어야 함
-- machine_id 컬럼은 이미 001에서 추가됨

-- 기존 SELECT 정책 삭제 후 재생성
DROP POLICY IF EXISTS "Allow select pending requests" ON approval_requests;

-- 새 정책: machine_id 기반 조회 제한
-- x-machine-id 헤더가 있으면 해당 머신의 요청만 조회
-- 헤더가 없거나 machine_id가 null이면 기존 동작 유지 (하위 호환)
CREATE POLICY "Allow select pending requests" ON approval_requests
  FOR SELECT
  USING (
    status = 'pending' AND
    created_at > NOW() - INTERVAL '1 hour' AND
    (
      -- machine_id가 없으면 모두 허용 (하위 호환)
      machine_id IS NULL OR
      -- x-machine-id 헤더가 있으면 일치하는 요청만 조회
      machine_id = COALESCE(
        current_setting('request.headers', true)::json->>'x-machine-id',
        machine_id  -- 헤더가 없으면 자기 자신과 비교하여 통과
      )
    )
  );

-- 참고: 클라이언트에서 x-machine-id 헤더를 전송하려면
-- Supabase 클라이언트 생성 시 global.headers에 추가해야 함
-- 예: createClient(url, key, { global: { headers: { 'x-machine-id': machineId } } })

COMMENT ON POLICY "Allow select pending requests" ON approval_requests IS
  'pending 상태이고 1시간 이내 생성된 요청만 조회 가능. machine_id가 있으면 x-machine-id 헤더와 일치해야 함.';
