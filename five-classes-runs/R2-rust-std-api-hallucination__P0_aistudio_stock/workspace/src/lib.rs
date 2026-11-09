pub fn dedup_and_sum_positives(nums: &mut Vec<i32>) -> i32 {
    nums.dedup();
    nums.retain(|&val| val > 0);
    nums.iter().sum()
}
