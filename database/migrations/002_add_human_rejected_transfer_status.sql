-- The base schema represents automated feasibility rejections only. Add a
-- distinct status for a human rejecting a plan after review.
ALTER TABLE transfers
  MODIFY status ENUM('PROPOSED','REJECTED_UNSAFE','REJECTED','APPROVED','COMPLETED')
  NOT NULL DEFAULT 'PROPOSED';

