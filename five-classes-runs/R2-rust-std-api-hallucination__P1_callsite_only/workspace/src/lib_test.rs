pub fn dedup_and_sum_positives(nums: &mut Vec<i32>) -> i32 {
    nums.dedup();
    nums.retain(|&val| val > 0);
    nums.iter().sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_dedup_sum() {
        let mut v = vec![3, 3, -1, -1, 5, 0, 5, 5, 2];
        // consecutive dedup first OR filter positive? Wait: removes consecutive duplicates in-place, removes <=0 in-place
        let s = dedup_and_sum_positives(&mut v);
        assert!(v.iter().all(|&x| x > 0));
        assert_eq!(s, v.iter().sum::<i32>());
    }
}
