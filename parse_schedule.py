import re
import json

def parse_schedule(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    schedule_data = {}
    current_group = None
    current_week_type = 'ОСНОВНИЙ РОЗКЛАД' # Default week type
    current_day = None

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Check for group
        group_match = re.match(r'ГРУПА:\s+(.+)', line)
        if group_match:
            current_group = group_match.group(1).strip()
            schedule_data[current_group] = {
                'ОСНОВНИЙ РОЗКЛАД': {},
                'ЧИСЕЛЬНИК': {},
                'ЗНАМЕННИК': {},
                'ПІДВІСКА': []
            }
            continue

        if not current_group:
            continue

        # Check for section headers
        if 'ОСНОВНИЙ РОЗКЛАД' in line:
            current_week_type = 'ОСНОВНИЙ РОЗКЛАД'
            continue
        elif 'ЧИСЕЛЬНИК' in line:
            current_week_type = 'ЧИСЕЛЬНИК'
            continue
        elif 'ЗНАМЕННИК' in line:
            current_week_type = 'ЗНАМЕННИК'
            continue
        elif 'ПІДВІСКА' in line:
            current_week_type = 'ПІДВІСКА'
            continue

        # Check for day
        days_of_week = ['Понеділок:', 'Вівторок:', 'Середа:', 'Четвер:', 'П\'ятниця:', 'Субота:', 'Неділя:']
        if line in days_of_week:
            current_day = line.replace(':', '')
            if current_day not in schedule_data[current_group][current_week_type]:
                schedule_data[current_group][current_week_type][current_day] = []
            continue

        # Check for pair (Regular lessons)
        if current_week_type in ['ОСНОВНИЙ РОЗКЛАД', 'ЧИСЕЛЬНИК', 'ЗНАМЕННИК']:
            pair_match = re.match(r'(\d+)\s+пара\s+\|\s+(.+)', line)
            if pair_match and current_day:
                number = pair_match.group(1).strip()
                details = pair_match.group(2).strip()
                
                parts = details.split('—')
                if len(parts) >= 2:
                    subject = parts[0].strip()
                    teacher = parts[1].strip()
                else:
                    subject = details
                    teacher = ""

                schedule_data[current_group][current_week_type][current_day].append({
                    "number": int(number),
                    "subject": subject,
                    "teacher": teacher
                })
        
        # Parse Подвеска (Replacements)
        elif current_week_type == 'ПІДВІСКА':
            # Format: 03.04 | 1 пара | Інж.і комп.графіка — Заячковська Л.М.
            rep_match = re.match(r'([\d\.]+)\s+\|\s+(\d+)\s+пара\s+\|\s+(.+)', line)
            if rep_match:
                date_str = rep_match.group(1).strip()
                number = int(rep_match.group(2).strip())
                details = rep_match.group(3).strip()
                parts = details.split('—')
                if len(parts) >= 2:
                    subject = parts[0].strip()
                    teacher = parts[1].strip()
                else:
                    subject = details
                    teacher = ""

                schedule_data[current_group]['ПІДВІСКА'].append({
                    "date": date_str,
                    "number": number,
                    "subject": subject,
                    "teacher": teacher
                })

    return schedule_data

if __name__ == "__main__":
    data = parse_schedule('всі_розклади.txt')
    # Filter out empty sections
    clean_data = {}
    for group, weeks in data.items():
        clean_weeks = {}
        for week_type, content in weeks.items():
            if content: # empty dict or list will be false
                clean_weeks[week_type] = content
        clean_data[group] = clean_weeks

    with open('app/schedule.json', 'w', encoding='utf-8') as f:
        json.dump(clean_data, f, ensure_ascii=False, indent=2)
    print("Parsed schedules successfully.")
